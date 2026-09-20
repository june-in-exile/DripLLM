import type {
  BatchSettlementChannelManager,
  Channel,
} from "@x402/evm/batch-settlement/server";
import type { AppConfig } from "../config.js";
import { withdrawDeadlineMs } from "./channels.js";
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
 * 提領競賽的告警(spec §9)。買方申請提領後,賣方只剩 withdrawDelay 可以把最新 voucher
 * claim 上鏈;過了就真的收不到錢,所以逾期要用 error 而不是 warn。
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
      logger.error("claim", `channel ${tag} 提領期限已過 ${-remainingSecs}s —— 未請款餘額可能收不回`);
    } else {
      logger.warn("claim", `channel ${tag} 提領申請中,須在 ${remainingSecs}s 內完成 claim`);
    }
  }
}

export type ClaimJob = Readonly<{ stop(options?: { flush?: boolean }): Promise<void> }>;

function startWithdrawalPoll(
  manager: BatchSettlementChannelManager,
  config: AppConfig,
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
        await manager.claim({
          maxClaimsPerBatch: config.maxClaimsPerBatch,
          selectClaimChannels: (channels) =>
            prioritizeWithdrawalPending(
              channels.filter((channel) => pendingIds.has(channel.channelId.toLowerCase())),
            ),
        });
      })
      .catch((error) => logger.error("claim", `提領插隊 claim 失敗:${String(error)}`))
      .finally(() => {
        inFlight = false;
      });
  }, config.withdrawPollMs);
  timer.unref();
  return timer;
}

export function startClaimJob(
  manager: BatchSettlementChannelManager,
  config: AppConfig,
): ClaimJob {
  manager.start({
    claimIntervalSecs: config.claimIntervalSecs,
    settleIntervalSecs: config.settleIntervalSecs,
    refundIntervalSecs: config.refundIdleSecs,
    maxClaimsPerBatch: config.maxClaimsPerBatch,
    selectClaimChannels: prioritizeWithdrawalPending,
    shouldSettle: ({ pendingSettle }) => pendingSettle,
    selectRefundChannels: (channels, { now }) =>
      channels.filter(
        (channel) => now - channel.lastRequestTimestamp >= config.refundIdleSecs * 1_000,
      ),
    onClaim: (result) => logger.info("claim", `${result.vouchers} voucher · tx ${result.transaction}`),
    onSettle: (result) => logger.info("settle", `tx ${result.transaction}`),
    onRefund: (result) => logger.info("refund", `${result.channel} · tx ${result.transaction}`),
    onError: (error) => logger.error("claim", String(error)),
  });

  const withdrawalTimer = startWithdrawalPoll(manager, config);

  return {
    async stop(options) {
      clearInterval(withdrawalTimer);
      await manager.stop(options);
    },
  };
}
