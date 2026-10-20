import type { SessionStore } from "./sessions.js";

export type Registry = Readonly<{
  getStore(): SessionStore;
  setStore(next: SessionStore): void;
  markCut(id: string, nowMs: number, ttlMs: number): void;
  isCut(id: string, nowMs: number, ttlMs: number): boolean;
}>;

/**
 * Mutability is confined to these two slots. The contents themselves are still immutable data.
 * Every handler reads fresh via getStore() and must never capture the store itself in a closure (spec §6.3.1).
 */
export function createRegistry(initial: SessionStore = new Map()): Registry {
  let store = initial;
  const cutAt = new Map<string, number>();

  return Object.freeze({
    getStore: () => store,
    setStore: (next: SessionStore) => {
      store = next;
    },
    /**
     * Marks a session as cut. Also sweeps expired old entries out of cutAt (nowMs - markedAt > ttlMs),
     * keeping the tombstone set's growth bounded. The cleanup is deliberate, not a side effect.
     */
    markCut: (id: string, nowMs: number, ttlMs: number) => {
      cutAt.set(id, nowMs);
      // sweep out expired old tombstones
      for (const [key, t] of cutAt.entries()) {
        if (nowMs - t > ttlMs) {
          cutAt.delete(key);
        }
      }
    },
    /**
     * Checks whether an id counts as cut within the TTL. Pure read, no side effects.
     */
    isCut: (id: string, nowMs: number, ttlMs: number) => {
      const t = cutAt.get(id);
      if (t === undefined) return false;
      if (nowMs - t > ttlMs) {
        return false;
      }
      return true;
    },
  });
}
