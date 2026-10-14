import type { Registry } from "./registry.js";
import type { StreamHub } from "./stream.js";
import { expiredSessions, inGrace, removeSession, type Session, type SessionStore } from "./sessions.js";
import { logger } from "../shared/logger.js";
import { formatUsd } from "../shared/usdc.js";

export type WatchdogDeps = Readonly<{
  registry: Registry;
  hub: StreamHub;
  graceMs: number;
  /** 已剪除 sessionId 的保留時間,擋重用(spec §6.3、TOMBSTONE_TTL_MS,由 config 注入)。 */
  tombstoneTtlMs: number;
  onCut?: (sessionId: string) => void;
}>;

export function createWatchdog(deps: WatchdogDeps): {
  sweep(nowMs: number): void;
  start(intervalMs: number): void;
  stop(): void;
} {
  let timer: NodeJS.Timeout | null = null;
  // 已印過寬限警告的「session:tickCount」。每次 sweep 依當下仍在寬限中的 session 重建,
  // 補款延長或剪除後自然移除;tickCount 入 key,所以同一 session 再次用完時會重新警告。
  let warned: ReadonlySet<string> = new Set();

  const tag = (session: Session): string => `session ${session.id.slice(0, 4)}`;
  const warnKey = (session: Session): string => `${session.id}:${session.tickCount}`;

  /** 穩定串流時一格 1 秒、餘額在 1 秒內來回,逐次印倒數會洗版 —— 只在真的用完時印一次。 */
  function warnLapsed(store: SessionStore, nowMs: number): void {
    const lapsed = [...store.values()].filter((s) => inGrace(s, nowMs, deps.graceMs));
    for (const session of lapsed) {
      if (warned.has(warnKey(session))) continue;
      logger.warn("watchdog", `${tag(session)} · 已付時間用完,寬限 ${deps.graceMs}ms`);
    }
    warned = new Set(lapsed.map(warnKey));
  }

  function sweep(nowMs: number): void {
    const { registry, hub, graceMs, tombstoneTtlMs, onCut } = deps;
    warnLapsed(registry.getStore(), nowMs);
    for (const session of expiredSessions(registry.getStore(), nowMs, graceMs)) {
      // 步驟 1:先取值 —— cut payload 需要 tickCount / spentAtomic,
      // 移除後再取會是 undefined,而那正是 demo 最後一行的結算摘要。
      const payload = {
        sessionId: session.id,
        reason: "payment_lapsed" as const,
        tickCount: session.tickCount,
        spentAtomic: session.spentAtomic.toString(),
      };

      // 步驟 2:先移除帳本並記 tombstone,再關連線。
      // res.end() 會觸發 close 事件,close handler 靠「是否仍在帳本中」區分是誰斷的。
      registry.setStore(removeSession(registry.getStore(), session.id));
      registry.markCut(session.id, nowMs, tombstoneTtlMs);

      // 步驟 3、4:送 cut 後關閉連線。
      hub.cut(session.id, payload);
      logger.cut(
        "watchdog",
        `${tag(session)} · 切斷串流 · 共 ${session.tickCount} 格 · ${formatUsd(session.spentAtomic)}`,
      );
      onCut?.(session.id);
    }
  }

  return {
    sweep,
    start(intervalMs: number): void {
      if (timer) return;
      timer = setInterval(() => sweep(Date.now()), intervalMs);
      // buildApp 啟動後 timer 不會被清除;unref 讓 vitest 與程序退出不被它卡住。
      timer.unref();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
