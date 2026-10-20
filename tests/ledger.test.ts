import { describe, it, expect } from "vitest";
import { createLedger, canAfford, recordTick } from "../src/agent/ledger.js";

describe("canAfford -- cap boundary", () => {
  it("can pay when the balance is ample", () => {
    expect(canAfford(createLedger(5000n, 1000n))).toBe(true);
  });

  it("can still pay when the remainder equals exactly one tick's price", () => {
    let l = createLedger(5000n, 1000n);
    for (let i = 0; i < 4; i++) l = recordTick(l);
    expect(l.spentAtomic).toBe(4000n);
    expect(canAfford(l)).toBe(true);
  });

  it("cannot pay when less than one tick remains", () => {
    let l = createLedger(5000n, 1000n);
    for (let i = 0; i < 5; i++) l = recordTick(l);
    expect(l.spentAtomic).toBe(5000n);
    expect(canAfford(l)).toBe(false);
  });

  it("cannot pay from the start when the cap is below one tick's price", () => {
    expect(canAfford(createLedger(500n, 1000n))).toBe(false);
  });
});

describe("recordTick", () => {
  it("returns a new object without modifying the original", () => {
    const l = createLedger(5000n, 1000n);
    const next = recordTick(l);
    expect(l.spentAtomic).toBe(0n);
    expect(next.spentAtomic).toBe(1000n);
    expect(next.tickCount).toBe(1);
  });
});
