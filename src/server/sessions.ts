export type Session = Readonly<{
  id: string;
  /** 取自 authorization.from,見 spec §2.6。後續 tick 須相符。 */
  payer: string;
  paidUntilMs: number;
  spentAtomic: bigint;
  tickCount: number;
  lastTxHash: string;
}>;

export type SessionStore = ReadonlyMap<string, Session>;

export type UpsertResult =
  | { ok: true; store: SessionStore; session: Session }
  | { ok: false; reason: "payer_mismatch" };

export function upsertSession(
  store: SessionStore,
  id: string,
  payer: string,
  nowMs: number,
  creditMs: number,
  priceAtomic: bigint,
  txHash: string,
): UpsertResult {
  const prev = store.get(id);
  if (prev && prev.payer !== payer) return { ok: false, reason: "payer_mismatch" };

  const base = prev ? Math.max(nowMs, prev.paidUntilMs) : nowMs;
  const session: Session = Object.freeze({
    id,
    payer,
    paidUntilMs: base + creditMs,
    spentAtomic: (prev?.spentAtomic ?? 0n) + priceAtomic,
    tickCount: (prev?.tickCount ?? 0) + 1,
    lastTxHash: txHash,
  });

  const next = new Map(store);
  next.set(id, session);
  return { ok: true, store: next, session };
}

/** 可為負值 —— agent 需藉此區分「將盡」與「已逾期」,見 spec §2.2.1。 */
export function remainingMs(session: Session, nowMs: number): number {
  return session.paidUntilMs - nowMs;
}

export function inGrace(session: Session, nowMs: number, graceMs: number): boolean {
  const remaining = remainingMs(session, nowMs);
  return remaining <= 0 && remaining > -graceMs;
}

export function expiredSessions(
  store: SessionStore,
  nowMs: number,
  graceMs: number,
): readonly Session[] {
  return [...store.values()].filter((s) => nowMs > s.paidUntilMs + graceMs);
}

export function removeSession(store: SessionStore, id: string): SessionStore {
  if (!store.has(id)) return store;
  const next = new Map(store);
  next.delete(id);
  return next;
}
