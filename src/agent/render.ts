import { formatUsd } from "../shared/usdc.js";
import { logger } from "../shared/logger.js";

export function renderTick(
  tickCount: number,
  txHash: string | undefined,
  spentAtomic: bigint,
  extra?: { balance?: string; ceiling?: string; cumulative?: string }
): void {
  const txPart = txHash ? `tx ${txHash.slice(0, 12)}…` : "voucher";
  let extraPart = "";
  if (extra?.balance != null) {
    extraPart = ` · bal ${formatUsd(BigInt(extra.balance))} / cap ${formatUsd(BigInt(extra.ceiling || "0"))} / sum ${formatUsd(BigInt(extra.cumulative || "0"))}`;
  }
  logger.info("agent", `tick #${tickCount} · ${formatUsd(spentAtomic)} total · ${txPart}${extraPart}`);
}

export function renderToken(token: string): void {
  process.stdout.write(token);
}

export function renderCredit(remainingMs: number, grace: boolean): void {
  if (grace) logger.warn("agent", `overdue, in grace period (${remainingMs}ms)`);
}

export function renderStopPaying(reason: "manual" | "cap", spentAtomic: bigint): void {
  process.stdout.write("\n");
  logger.warn(
    "agent",
    reason === "manual"
      ? "stopped paying, connection held open - waiting for server to cut"
      : `spend cap ${formatUsd(spentAtomic)} reached, stopped paying - waiting for server to cut`,
  );
}

export function renderCut(tickCount: number, spentAtomic: bigint): void {
  process.stdout.write("\n");
  logger.error("agent", `stream cut by server · ${tickCount} ticks · total spent ${formatUsd(spentAtomic)}`);
}
