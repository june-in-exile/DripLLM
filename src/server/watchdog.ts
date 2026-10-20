import type { Registry } from "./registry.js";
import type { StreamHub } from "./stream.js";
import { expiredSessions, inGrace, removeSession, type Session, type SessionStore } from "./sessions.js";
import { logger } from "../shared/logger.js";
import { formatUsd } from "../shared/usdc.js";

export type WatchdogDeps = Readonly<{
  registry: Registry;
  hub: StreamHub;
  graceMs: number;
  /** How long cut sessionIds are kept, to block reuse (spec §6.3, TOMBSTONE_TTL_MS, injected from config). */
  tombstoneTtlMs: number;
  onCut?: (sessionId: string) => void;
}>;

export function createWatchdog(deps: WatchdogDeps): {
  sweep(nowMs: number): void;
  start(intervalMs: number): void;
  stop(): void;
} {
  let timer: NodeJS.Timeout | null = null;
  // "session:tickCount" keys already given a grace warning. Rebuilt each sweep from the sessions currently in grace,
  // so entries drop out naturally after a top-up or a cut; tickCount is in the key, so the same session warns again when it runs out again.
  let warned: ReadonlySet<string> = new Set();

  const tag = (session: Session): string => `session ${session.id.slice(0, 4)}`;
  const warnKey = (session: Session): string => `${session.id}:${session.tickCount}`;

  /** In a steady stream a tick is 1 second and the remaining credit swings within 1 second; printing a countdown every sweep would flood the log — print once, only when it actually runs out. */
  function warnLapsed(store: SessionStore, nowMs: number): void {
    const lapsed = [...store.values()].filter((s) => inGrace(s, nowMs, deps.graceMs));
    for (const session of lapsed) {
      if (warned.has(warnKey(session))) continue;
      logger.warn("watchdog", `${tag(session)} · paid time used up, grace period ${deps.graceMs}ms`);
    }
    warned = new Set(lapsed.map(warnKey));
  }

  function sweep(nowMs: number): void {
    const { registry, hub, graceMs, tombstoneTtlMs, onCut } = deps;
    warnLapsed(registry.getStore(), nowMs);
    for (const session of expiredSessions(registry.getStore(), nowMs, graceMs)) {
      // Step 1: read the values first — the cut payload needs tickCount / spentAtomic,
      // and reading them after removal gives undefined, which is exactly the settlement summary on the demo's last line.
      const payload = {
        sessionId: session.id,
        reason: "payment_lapsed" as const,
        tickCount: session.tickCount,
        spentAtomic: session.spentAtomic.toString(),
      };

      // Step 2: remove from the ledger and record the tombstone first, then close the connection.
      // res.end() fires the close event, and the close handler uses "still in the ledger?" to tell who disconnected.
      registry.setStore(removeSession(registry.getStore(), session.id));
      registry.markCut(session.id, nowMs, tombstoneTtlMs);

      // Steps 3 and 4: send cut, then close the connection.
      hub.cut(session.id, payload);
      logger.cut(
        "watchdog",
        `${tag(session)} · stream cut · ${session.tickCount} ticks total · ${formatUsd(session.spentAtomic)}`,
      );
      onCut?.(session.id);
    }
  }

  return {
    sweep,
    start(intervalMs: number): void {
      if (timer) return;
      timer = setInterval(() => sweep(Date.now()), intervalMs);
      // The timer is never cleared after buildApp starts; unref keeps it from holding up vitest and process exit.
      timer.unref();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
