import type { SessionStore } from "./sessions.js";

export type Registry = Readonly<{
  getStore(): SessionStore;
  setStore(next: SessionStore): void;
  markCut(id: string, nowMs: number): void;
  isCut(id: string, nowMs: number, ttlMs: number): boolean;
}>;

/**
 * 可變性被侷限在這裡的兩格。內容物本身仍是不可變資料。
 * 所有 handler 一律經 getStore() 現讀,不得閉包捕獲 store 本身(spec §6.3.1)。
 */
export function createRegistry(initial: SessionStore = new Map()): Registry {
  let store = initial;
  const cutAt = new Map<string, number>();

  return Object.freeze({
    getStore: () => store,
    setStore: (next: SessionStore) => {
      store = next;
    },
    markCut: (id: string, nowMs: number) => {
      cutAt.set(id, nowMs);
    },
    isCut: (id: string, nowMs: number, ttlMs: number) => {
      const t = cutAt.get(id);
      if (t === undefined) return false;
      if (nowMs - t > ttlMs) {
        cutAt.delete(id);
        return false;
      }
      return true;
    },
  });
}
