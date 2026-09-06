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

describe("upsertSession —— 建立", () => {
  it("建立新 session,paidUntil = now + credit", () => {
    const r = seed(1000);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.session.paidUntilMs).toBe(6000);
    expect(r.session.tickCount).toBe(1);
    expect(r.session.spentAtomic).toBe(1000n);
    expect(r.session.payer).toBe(PAYER);
    expect(r.session.lastTxHash).toBe("0xtx1");
  });

  it("不修改傳入的 store", () => {
    seed();
    expect(empty.size).toBe(0);
  });
});

describe("upsertSession —— 延長", () => {
  it("餘額未用盡時,自 paidUntil 往後累加,不是自 now", () => {
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

  it("餘額已用盡時,自 now 起算", () => {
    const first = seed(1000);
    if (!first.ok) return;
    const second = upsertSession(first.store, "s1", PAYER, 9000, 5000, 1000n, "0xtx2");
    if (!second.ok) return;
    expect(second.session.paidUntilMs).toBe(14000); // max(9000, 6000) + 5000
  });

  it("payer 不符時拒絕,且不改動 store", () => {
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
  it("餘額充足時為正", () => {
    const r = seed(1000);
    if (!r.ok) return;
    expect(remainingMs(r.session, 3000)).toBe(3000);
  });

  it("逾期時為負,不 clamp 在 0", () => {
    const r = seed(1000);
    if (!r.ok) return;
    expect(remainingMs(r.session, 7500)).toBe(-1500);
  });
});

describe("inGrace", () => {
  it("餘額未用盡時不算寬限期", () => {
    const r = seed(1000);
    if (!r.ok) return;
    expect(inGrace(r.session, 5000, 2000)).toBe(false);
  });

  it("逾期但仍在寬限內為 true", () => {
    const r = seed(1000);
    if (!r.ok) return;
    expect(inGrace(r.session, 7000, 2000)).toBe(true);
  });

  it("超過寬限後為 false", () => {
    const r = seed(1000);
    if (!r.ok) return;
    expect(inGrace(r.session, 8500, 2000)).toBe(false);
  });
});

describe("expiredSessions —— 邊界", () => {
  it("剛好在寬限期最後 1ms 不算逾期", () => {
    const r = seed(1000);
    if (!r.ok) return;
    expect(expiredSessions(r.store, 8000, 2000)).toHaveLength(0);
  });

  it("超過寬限 1ms 即算逾期", () => {
    const r = seed(1000);
    if (!r.ok) return;
    expect(expiredSessions(r.store, 8001, 2000)).toHaveLength(1);
  });
});

describe("removeSession", () => {
  it("回傳新 store,原 store 不變", () => {
    const r = seed();
    if (!r.ok) return;
    const next = removeSession(r.store, "s1");
    expect(next.has("s1")).toBe(false);
    expect(r.store.has("s1")).toBe(true);
  });

  it("移除不存在的 id 不拋錯", () => {
    expect(() => removeSession(empty, "nope")).not.toThrow();
  });
});
