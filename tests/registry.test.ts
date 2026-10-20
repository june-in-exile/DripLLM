import { describe, it, expect } from "vitest";
import { createRegistry } from "../src/server/registry.js";
import { upsertSession } from "../src/server/sessions.js";

const PAYER = "0xaaaa000000000000000000000000000000000001";

describe("createRegistry — stale snapshot problem", () => {
  it("after the store is updated, a previously obtained accessor reads the new value", () => {
    const reg = createRegistry();
    const read = () => reg.getStore(); // simulates a handler capturing the accessor at registration time
    expect(read().size).toBe(0);

    const r = upsertSession(reg.getStore(), "s1", PAYER, 1000, 5000, 1000n, "0xtx");
    if (!r.ok) throw new Error("upsert failed");
    reg.setStore(r.store);

    expect(read().size).toBe(1);
    expect(read().has("s1")).toBe(true);
  });

  it("after removal, the same accessor reads the removed state", () => {
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
  it("is cut within the TTL after marking", () => {
    const reg = createRegistry();
    reg.markCut("s1", 1000, 60000);
    expect(reg.isCut("s1", 2000, 60000)).toBe(true);
  });

  it("is no longer considered cut after the TTL", () => {
    const reg = createRegistry();
    reg.markCut("s1", 1000, 60000);
    expect(reg.isCut("s1", 61001, 60000)).toBe(false);
  });

  it("is false for an unmarked id", () => {
    const reg = createRegistry();
    expect(reg.isCut("never", 1000, 60000)).toBe(false);
  });

  it("TTL boundary: exactly at the TTL still counts as cut", () => {
    const reg = createRegistry();
    reg.markCut("s1", 1000, 60000);
    expect(reg.isCut("s1", 61000, 60000)).toBe(true);
  });

  it("isCut has no side effects: repeated calls on the same id (the second with a smaller nowMs) agree", () => {
    const reg = createRegistry();
    reg.markCut("s1", 1000, 60000);
    // First call at time 61001 (past the TTL, diff 60001 > 60000)
    expect(reg.isCut("s1", 61001, 60000)).toBe(false);
    // Call again at time 50000 (within the TTL, diff 49000 < 60000)
    // If isCut had side effects (deleting the tombstone), this would return false (because s1 was deleted)
    // If isCut has no side effects (pure read), this returns true (because s1 is still in cutAt)
    expect(reg.isCut("s1", 50000, 60000)).toBe(true);
  });

  it("markCut sweeps out expired old tombstones", () => {
    const reg = createRegistry();
    const ttl = 60000;
    // mark a at time 1000
    reg.markCut("a", 1000, ttl);
    // mark c at time 70000 (a has expired by now: 70000-1000=69000 > 60000)
    // markCut should sweep a out in its cleanup loop
    reg.markCut("c", 70000, ttl);
    // check a within its validity window
    // if a was swept out           → not in isCut → false
    // if a still exists (not cleaned) → 50000-1000=49000 is not greater than 60000 → true
    // this is what tells "cleaned" apart from "not cleaned"
    expect(reg.isCut("a", 50000, ttl)).toBe(false);

    // confirm unexpired entries aren't swept by mistake:
    // mark b at time 30000
    reg.markCut("b", 30000, ttl);
    // advance time to 50000, mark d
    // b is still valid (50000-30000=20000 is not greater than 60000)
    reg.markCut("d", 50000, ttl);
    // check b is still there
    expect(reg.isCut("b", 45000, ttl)).toBe(true);

    // confirm the entry being written isn't swept by its own cleanup:
    // mark x at time 100000; no other entry should be expired now (assuming only x is new)
    reg.markCut("x", 100000, ttl);
    // x is within its validity window
    expect(reg.isCut("x", 100001, ttl)).toBe(true);
  });
});
