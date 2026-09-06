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
    reg.markCut("s1", 1000, 60000);
    expect(reg.isCut("s1", 2000, 60000)).toBe(true);
  });

  it("超過 TTL 後不再視為已剪除", () => {
    const reg = createRegistry();
    reg.markCut("s1", 1000, 60000);
    expect(reg.isCut("s1", 61001, 60000)).toBe(false);
  });

  it("未標記的 id 為 false", () => {
    const reg = createRegistry();
    expect(reg.isCut("never", 1000, 60000)).toBe(false);
  });

  it("TTL 邊界:剛好等於 TTL 仍視為已剪除", () => {
    const reg = createRegistry();
    reg.markCut("s1", 1000, 60000);
    expect(reg.isCut("s1", 61000, 60000)).toBe(true);
  });

  it("isCut 無副作用:連續呼叫同一 id(第二次較小 nowMs)結果一致", () => {
    const reg = createRegistry();
    reg.markCut("s1", 1000, 60000);
    // 先呼叫一次,用時間 61001(超過 TTL,時間差 60001 > 60000)
    expect(reg.isCut("s1", 61001, 60000)).toBe(false);
    // 再呼叫一次,用時間 50000(在 TTL 內,時間差 49000 < 60000)
    // 如果 isCut 有副作用(刪除 tombstone),這會返回 false(因為 s1 被刪掉)
    // 如果 isCut 無副作用(純讀),這會返回 true(因為 s1 仍在 cutAt 中)
    expect(reg.isCut("s1", 50000, 60000)).toBe(true);
  });

  it("markCut 會清掉已過期的舊 tombstone", () => {
    const reg = createRegistry();
    const ttl = 60000;
    // 標記 s1 在時間 1000
    reg.markCut("s1", 1000, ttl);
    // 時間推進到 70000,此時 s1 已過期
    // 標記 s2 在時間 70000,同時清理會掃掉 s1
    reg.markCut("s2", 70000, ttl);
    // 檢查 s1 是否仍被視為已剪除
    // (它應該被清掉,所以返回 false)
    expect(reg.isCut("s1", 70000, ttl)).toBe(false);
    // 檢查 s2 在新時間內仍被視為已剪除
    expect(reg.isCut("s2", 70001, ttl)).toBe(true);
  });
});
