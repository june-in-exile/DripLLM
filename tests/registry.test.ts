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
    // 標記 a 在時間 1000
    reg.markCut("a", 1000, ttl);
    // 標記 c 在時間 70000(此時 a 已過期:70000-1000=69000 > 60000)
    // markCut 應在清理迴圈中掃掉 a
    reg.markCut("c", 70000, ttl);
    // 在有效期內檢查 a
    // 若 a 已被掃掉     → isCut 不存在 → false
    // 若 a 還存在(未清理) → 50000-1000=49000 不大於 60000 → true
    // 這樣才能區分「有清理」和「沒清理」的結果
    expect(reg.isCut("a", 50000, ttl)).toBe(false);

    // 確認未過期項目不會被誤掃:
    // 標記 b 在時間 30000
    reg.markCut("b", 30000, ttl);
    // 時間推進到 50000,標記 d
    // b 還在有效期內(50000-30000=20000 不大於 60000)
    reg.markCut("d", 50000, ttl);
    // 檢查 b 仍在
    expect(reg.isCut("b", 45000, ttl)).toBe(true);

    // 確認正在寫入的項目不會被自己清理掃掉:
    // 標記 x 在時間 100000,此時應沒有其他項目超期(假設此時只有 x 是新的)
    reg.markCut("x", 100000, ttl);
    // x 在有效期內
    expect(reg.isCut("x", 100001, ttl)).toBe(true);
  });
});
