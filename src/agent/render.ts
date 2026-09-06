import { formatUsd } from "../shared/usdc.js";
import { logger } from "../shared/logger.js";

export function renderTick(tickCount: number, txHash: string, spentAtomic: bigint): void {
  logger.info("agent", `tick #${tickCount} · ${formatUsd(spentAtomic)} 累計 · tx ${txHash.slice(0, 12)}…`);
}

export function renderToken(token: string): void {
  process.stdout.write(token);
}

export function renderCredit(remainingMs: number, grace: boolean): void {
  if (grace) logger.warn("agent", `已逾期,寬限期中(${remainingMs}ms)`);
}

export function renderStopPaying(reason: "manual" | "cap", spentAtomic: bigint): void {
  process.stdout.write("\n");
  logger.warn(
    "agent",
    reason === "manual"
      ? "已停止付款,連線保持中 —— 等待 server 斷流"
      : `已達花費上限 ${formatUsd(spentAtomic)},停止付款 —— 等待 server 斷流`,
  );
}

export function renderCut(tickCount: number, spentAtomic: bigint): void {
  process.stdout.write("\n");
  logger.error("agent", `串流已被 server 切斷 · 共 ${tickCount} 個 tick · 總花費 ${formatUsd(spentAtomic)}`);
}
