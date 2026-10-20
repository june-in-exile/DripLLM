import type { Registry } from "./registry.js";
import { upsertSession } from "./sessions.js";
import { extractPayer } from "./payer.js";
import {
  canServe,
  needsDepositTopUp,
  parseChannelAmounts,
  remainingTicks,
} from "./channels.js";
import { logger } from "../shared/logger.js";

export type SettleHookDeps = Readonly<{
  registry: Registry;
  creditMs: number;
  priceAtomic: bigint;
  depositTopupAtomic: bigint;
}>;

type HookContext = {
  paymentPayload: { payload?: unknown };
  result: { transaction: string; payer?: string; extra?: unknown };
  transportContext?: { request?: { adapter?: { getHeader(name: string): string | undefined } } };
};

function readChannelState(extra: unknown): unknown {
  if (typeof extra !== "object" || extra === null) return undefined;
  return (extra as { channelState?: unknown }).channelState;
}

/**
 * Deposit gate (spec §2.5.1). The protocol only guarantees a voucher doesn't exceed the cap the buyer signed, not that the deposit covers it,
 * so after each tick settles we check whether the deposit can still cover the next tick, and warn if it can't —
 * the next /tick will be blocked with a 402, paidUntil stops being extended, and the watchdog cuts naturally (spec §7).
 *
 * @returns number of ticks that can be served; null when channelState is incomplete (no guessing numbers).
 */
function reportChannelHealth(
  sessionId: string,
  extra: unknown,
  deps: SettleHookDeps,
  lowBalance: Set<string>,
): number | null {
  const channel = parseChannelAmounts(readChannelState(extra));
  if (!channel) return null;

  const tag = sessionId.slice(0, 4);
  const ticks = remainingTicks(channel, deps.priceAtomic);
  if (!canServe(channel, deps.priceAtomic)) {
    logger.warn("channel", `session ${tag} deposit can't cover the next tick, next /tick will be rejected`);
    return ticks;
  }
  // Edge-triggered. The top-up amount is the same order of magnitude as the warning threshold, so checking every tick would dip below it again right after a top-up,
  // producing a line of noise every second — only speak up on the tick that crosses the threshold.
  if (needsDepositTopUp(channel, deps.depositTopupAtomic)) {
    if (!lowBalance.has(sessionId)) {
      lowBalance.add(sessionId);
      logger.warn("channel", `session ${tag} deposit running low, ${ticks} ticks left`);
    }
  } else {
    lowBalance.delete(sessionId);
  }
  return ticks;
}

/**
 * The single entry point for creating and extending sessions.
 * Lives in onAfterSettle rather than the Express handler, because settle sits on the response's critical path —
 * computing paidUntil inside the handler would be eroded by settlement latency (spec §2.5).
 */
export function createSettleHook(deps: SettleHookDeps) {
  /** Sessions already warned about "deposit running low", so the warning fires only once, when crossing the threshold. */
  const lowBalance = new Set<string>();

  return async function onAfterSettle(ctx: HookContext): Promise<void> {
    const sessionId = ctx.transportContext?.request?.adapter?.getHeader("X-Drip-Session");
    if (!sessionId) {
      // Refunds go through the same /tick, which never had a session to begin with — not an error.
      logger.info("hook", "settled without X-Drip-Session (refund or probe), not creating a session");
      return;
    }

    // Tombstones are already blocked by the /tick handler before settlement (spec §2.2.1); nothing to do here.
    const payer = extractPayer(ctx.paymentPayload.payload, ctx.result.payer);
    const result = upsertSession(
      deps.registry.getStore(),
      sessionId,
      payer,
      Date.now(),
      deps.creditMs,
      deps.priceAtomic,
      ctx.result.transaction,
    );

    if (!result.ok) {
      // Can't return 403 — the hook runs after the response is finalized. The session just stops being extended
      // and is eventually cut by the watchdog (spec §7).
      logger.error("hook", `session ${sessionId.slice(0, 4)} belongs to another payer, refusing to extend`);
      return;
    }

    deps.registry.setStore(result.store);
    const ticks = reportChannelHealth(sessionId, ctx.result.extra, deps, lowBalance);
    const settled = ctx.result.transaction ? `tx ${ctx.result.transaction.slice(0, 10)}` : "voucher";
    const budget = ticks === null ? "" : ` · deposit covers ${ticks} more ticks`;
    logger.info(
      "hook",
      `session ${sessionId.slice(0, 4)} · tick #${result.session.tickCount} · ${settled}${budget}`,
    );
  };
}
