import { describe, it, expect } from "vitest";
import { createRegistry } from "../src/server/registry.js";
import { upsertSession } from "../src/server/sessions.js";

const PAYER = "0xaaaa000000000000000000000000000000000001";

describe("createRegistry —— 舊快照問題", () => {
  it("更新 store 後,先前取得的存取器讀到新值", () => {
    const reg = createRegistry();
    const read = () => reg.getStore(); // 模擬 handler 在註冊時捕獲存取器
    expect(read().size).toBe(0);

    const r = upsertSession(reg.getStore(), "s1", PAYER, 1000, 5000, 1000n, "0xtx");
    if (!r.ok) throw new Error("upsert failed");
    reg.setStore(r.store);

    expect(read().size).toBe(1);
    expect(read().has("s1")).toBe(true);
  });

  it("移除後,同一個存取器讀到已移除的狀態", () => {
    const reg = createRegistry();
    const read = () => reg.getStore();
    const r = upsertSession(reg.getStore(), "s1", PAYER, 1000, 5000, 1000n, "0xtx");
    if (!r.ok) throw new Error("upsert failed");
    reg.setStore(r.store);
    reg.setStore(new Map());
    expect(read().has("s1")).toBe(false);
  });
});

describe("tombstone", () => {
  it("標記後在 TTL 內為已剪除", () => {
    const reg = createRegistry();
    reg.markCut("s1", 1000);
    expect(reg.isCut("s1", 2000, 60000)).toBe(true);
  });

  it("超過 TTL 後不再視為已剪除", () => {
    const reg = createRegistry();
    reg.markCut("s1", 1000);
    expect(reg.isCut("s1", 61001, 60000)).toBe(false);
  });

  it("未標記的 id 為 false", () => {
    const reg = createRegistry();
    expect(reg.isCut("never", 1000, 60000)).toBe(false);
  });

  it("TTL 邊界:剛好等於 TTL 仍視為已剪除", () => {
    const reg = createRegistry();
    reg.markCut("s1", 1000);
    expect(reg.isCut("s1", 61000, 60000)).toBe(true);
  });
});
