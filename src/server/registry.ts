import type { SessionStore } from "./sessions.js";

export type Registry = Readonly<{
  getStore(): SessionStore;
  setStore(next: SessionStore): void;
  markCut(id: string, nowMs: number, ttlMs: number): void;
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
    /**
     * 標記某個 session 已被切斷。同時掃掉 cutAt 中已過期(nowMs - markedAt > ttlMs)的舊項目,
     * 確保 tombstone 集合的成長有界。清理是刻意設計,不是副作用。
     */
    markCut: (id: string, nowMs: number, ttlMs: number) => {
      cutAt.set(id, nowMs);
      // 掃掉已過期的舊 tombstone
      for (const [key, t] of cutAt.entries()) {
        if (nowMs - t > ttlMs) {
          cutAt.delete(key);
        }
      }
    },
    /**
     * 檢查某個 id 是否在 TTL 內被視為已剪除。純讀操作,無副作用。
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
