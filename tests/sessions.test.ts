import { describe, it, expect } from "vitest";
import {
  upsertSession, remainingMs, inGrace, expiredSessions, removeSession,
  type SessionStore,
} from "../src/server/sessions.js";

const PAYER = "0xaaaa000000000000000000000000000000000001";
const OTHER = "0xbbbb000000000000000000000000000000000002";
const empty: SessionStore = new Map();

function seed(nowMs = 1000) {
  const r = upsertSession(empty, "s1", PAYER, nowMs, 5000, 1000n, "0xtx1");
  if (!r.ok) throw new Error("seed failed");
  return r;
}

describe("upsertSession — create", () => {
  it("creates a new session, paidUntil = now + credit", () => {
    const r = seed(1000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.session.paidUntilMs).toBe(6000);
    expect(r.session.tickCount).toBe(1);
    expect(r.session.spentAtomic).toBe(1000n);
    expect(r.session.payer).toBe(PAYER);
    expect(r.session.lastTxHash).toBe("0xtx1");
  });

  it("doesn't mutate the passed-in store", () => {
    seed();
    expect(empty.size).toBe(0);
  });
});

describe("upsertSession — extend", () => {
  it("accumulates from paidUntil, not from now, while credit remains", () => {
    const first = seed(1000);
    if (!first.ok) return;
    const second = upsertSession(first.store, "s1", PAYER, 3000, 5000, 1000n, "0xtx2");
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.session.paidUntilMs).toBe(11000); // max(3000, 6000) + 5000
    expect(second.session.tickCount).toBe(2);
    expect(second.session.spentAtomic).toBe(2000n);
    expect(second.session.lastTxHash).toBe("0xtx2");
  });

  it("counts from now once credit is used up", () => {
    const first = seed(1000);
    if (!first.ok) return;
    const second = upsertSession(first.store, "s1", PAYER, 9000, 5000, 1000n, "0xtx2");
    if (!second.ok) return;
    expect(second.session.paidUntilMs).toBe(14000); // max(9000, 6000) + 5000
  });

  it("rejects on payer mismatch without changing the store", () => {
    const first = seed(1000);
    if (!first.ok) return;
    const second = upsertSession(first.store, "s1", OTHER, 3000, 5000, 1000n, "0xtx2");
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.reason).toBe("payer_mismatch");
    expect(first.store.get("s1")?.tickCount).toBe(1);
  });
});

describe("remainingMs", () => {
  it("is positive when credit is ample", () => {
    const r = seed(1000);
    if (!r.ok) return;
    expect(remainingMs(r.session, 3000)).toBe(3000);
  });

  it("is negative when overdue, not clamped at 0", () => {
    const r = seed(1000);
    if (!r.ok) return;
    expect(remainingMs(r.session, 7500)).toBe(-1500);
  });
});

describe("inGrace", () => {
  it("isn't in the grace period while credit remains", () => {
    const r = seed(1000);
    if (!r.ok) return;
    expect(inGrace(r.session, 5000, 2000)).toBe(false);
  });

  it("is true when overdue but still within grace", () => {
    const r = seed(1000);
    if (!r.ok) return;
    expect(inGrace(r.session, 7000, 2000)).toBe(true);
  });

  it("is false past the grace period", () => {
    const r = seed(1000);
    if (!r.ok) return;
    expect(inGrace(r.session, 8500, 2000)).toBe(false);
  });
});

describe("expiredSessions — boundaries", () => {
  it("isn't expired in the last 1ms of the grace period", () => {
    const r = seed(1000);
    if (!r.ok) return;
    expect(expiredSessions(r.store, 8000, 2000)).toHaveLength(0);
  });

  it("is expired 1ms past grace", () => {
    const r = seed(1000);
    if (!r.ok) return;
    expect(expiredSessions(r.store, 8001, 2000)).toHaveLength(1);
  });
});

describe("removeSession", () => {
  it("returns a new store and leaves the original unchanged", () => {
    const r = seed();
    if (!r.ok) return;
    const next = removeSession(r.store, "s1");
    expect(next.has("s1")).toBe(false);
    expect(r.store.has("s1")).toBe(true);
  });

  it("doesn't throw when removing a nonexistent id", () => {
    expect(() => removeSession(empty, "nope")).not.toThrow();
  });
});
