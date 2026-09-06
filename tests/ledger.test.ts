import { describe, it, expect } from "vitest";
import { createLedger, canAfford, recordTick } from "../src/agent/ledger.js";

describe("canAfford —— 上限邊界", () => {
  it("餘額充足時可付", () => {
    expect(canAfford(createLedger(5000n, 1000n))).toBe(true);
  });

  it("剩餘剛好等於單筆價格時仍可付", () => {
    let l = createLedger(5000n, 1000n);
    for (let i = 0; i < 4; i++) l = recordTick(l);
    expect(l.spentAtomic).toBe(4000n);
    expect(canAfford(l)).toBe(true);
  });

  it("剩餘不足一筆時不可付", () => {
    let l = createLedger(5000n, 1000n);
    for (let i = 0; i < 5; i++) l = recordTick(l);
    expect(l.spentAtomic).toBe(5000n);
    expect(canAfford(l)).toBe(false);
  });

  it("上限小於單筆價格時一開始就不可付", () => {
    expect(canAfford(createLedger(500n, 1000n))).toBe(false);
  });
});

describe("recordTick", () => {
  it("回傳新物件,不修改原本的", () => {
    const l = createLedger(5000n, 1000n);
    const next = recordTick(l);
    expect(l.spentAtomic).toBe(0n);
    expect(next.spentAtomic).toBe(1000n);
    expect(next.tickCount).toBe(1);
  });
});
