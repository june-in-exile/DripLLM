import type {
  BatchSettlementChannelManager,
  Channel,
} from "@x402/evm/batch-settlement/server";
import type { AppConfig } from "../config.js";
import { hasRefundableBalance, withdrawDeadlineMs } from "./channels.js";
import { logger } from "../shared/logger.js";

export function prioritizeWithdrawalPending(channels: Channel[]): Channel[] {
  return [...channels].sort((left, right) => {
    const leftPending = left.withdrawRequestedAt > 0;
    const rightPending = right.withdrawRequestedAt > 0;
    if (leftPending !== rightPending) return leftPending ? -1 : 1;
    if (leftPending && rightPending) {
      return left.withdrawRequestedAt - right.withdrawRequestedAt;
    }
    return left.lastRequestTimestamp - right.lastRequestTimestamp;
  });
}

/**
 * Withdrawal-race alert (spec §9). Once the buyer requests a withdrawal, the seller has only withdrawDelay to get the latest voucher
 * claimed on-chain; after that the money is truly lost, so being overdue is an error, not a warn.
 */
export function reportWithdrawDeadlines(
  channels: Channel[],
  withdrawDelaySecs: number,
  nowMs: number,
): void {
  for (const channel of channels) {
    const deadline = withdrawDeadlineMs(channel, withdrawDelaySecs);
    if (deadline === null) continue;
    const tag = channel.channelId.slice(0, 10);
    const remainingSecs = Math.round((deadline - nowMs) / 1_000);
    if (remainingSecs <= 0) {
      logger.error("claim", `channel ${tag} withdrawal deadline passed ${-remainingSecs}s ago — unclaimed balance may be unrecoverable`);
    } else {
      logger.warn("claim", `channel ${tag} withdrawal requested, claim must complete within ${remainingSecs}s`);
    }
  }
}

export type ClaimJob = Readonly<{ stop(options?: { flush?: boolean }): Promise<void> }>;

type ClaimLogger = (result: ClaimResult) => void;

function startWithdrawalPoll(
  manager: BatchSettlementChannelManager,
  config: AppConfig,
  onClaim: ClaimLogger,
): NodeJS.Timeout {
  let inFlight = false;
  const timer = setInterval(() => {
    if (inFlight) return;
    inFlight = true;
    void manager
      .getWithdrawalPendingSessions()
      .then(async (pending) => {
        if (pending.length === 0) return;
        reportWithdrawDeadlines(pending, config.withdrawDelaySecs, Date.now());
        const pendingIds = new Set(pending.map((channel) => channel.channelId.toLowerCase()));
        const results = await manager.claim({
          maxClaimsPerBatch: config.maxClaimsPerBatch,
          selectClaimChannels: (channels) =>
            prioritizeWithdrawalPending(
              channels.filter((channel) => pendingIds.has(channel.channelId.toLowerCase())),
            ),
        });
        results.forEach(onClaim);
      })
      .catch((error) => logger.error("claim", `withdrawal-priority claim failed: ${String(error)}`))
      .finally(() => {
        inFlight = false;
      });
  }, config.withdrawPollMs);
  timer.unref();
  return timer;
}

type ClaimResult = { vouchers: number; transaction: string };
type SettleResult = { transaction: string };

const logClaim = (result: ClaimResult) =>
  logger.info("claim", `${result.vouchers} voucher · tx ${result.transaction}`);
const logSettle = (result: SettleResult) =>
  logger.info("settle", `tx ${result.transaction}`);

/**
 * Settlement before shutdown. Not using manager.stop({ flush: true }) — its internal claimAndSettle
 * doesn't trigger onClaim/onSettle, so on success there is no log at all and no way to tell whether the money went out.
 *
 * claimAndSettle only settles when this flush makes a new claim. If a scheduled claim already took the voucher
 * and the settle cycle hasn't come round yet, that money sits at "claimed, not settled" — so when unsettled, settle it too.
 * Errors propagate up; main prints "shutdown settlement failed".
 */
async function flushClaims(
  manager: BatchSettlementChannelManager,
  config: AppConfig,
  unsettled: boolean,
): Promise<void> {
  const { claims, settle } = await manager.claimAndSettle({
    maxClaimsPerBatch: config.maxClaimsPerBatch,
    selectClaimChannels: prioritizeWithdrawalPending,
  });
  claims.forEach(logClaim);
  if (settle) {
    logSettle(settle);
    return;
  }
  if (unsettled) {
    logSettle(await manager.settle());
    return;
  }
  logger.info("claim", "nothing pending settlement at shutdown");
}

export function startClaimJob(
  manager: BatchSettlementChannelManager,
  config: AppConfig,
): ClaimJob {
  // Funds this process has claimed but not yet settled. In memory only — after a restart they wait for the next claim to be settled.
  let unsettled = false;
  const recordClaim: ClaimLogger = (result) => {
    unsettled = true;
    logClaim(result);
  };
  const recordSettle = (result: SettleResult) => {
    unsettled = false;
    logSettle(result);
  };

  manager.start({
    claimIntervalSecs: config.claimIntervalSecs,
    settleIntervalSecs: config.settleIntervalSecs,
    refundIntervalSecs: config.refundIdleSecs,
    maxClaimsPerBatch: config.maxClaimsPerBatch,
    selectClaimChannels: prioritizeWithdrawalPending,
    shouldSettle: ({ pendingSettle }) => pendingSettle,
    selectRefundChannels: (channels, { now }) =>
      channels.filter(
        (channel) =>
          hasRefundableBalance(channel) &&
          now - channel.lastRequestTimestamp >= config.refundIdleSecs * 1_000,
      ),
    onClaim: recordClaim,
    onSettle: recordSettle,
    onRefund: (result) => logger.info("refund", `${result.channel} · tx ${result.transaction}`),
    onError: (error) => logger.error("claim", String(error)),
  });

  const withdrawalTimer = startWithdrawalPoll(manager, config, recordClaim);

  return {
    async stop(options) {
      clearInterval(withdrawalTimer);
      await manager.stop();
      if (options?.flush) await flushClaims(manager, config, unsettled);
    },
  };
}
