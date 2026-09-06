export type SpendLedger = Readonly<{
  spentAtomic: bigint;
  tickCount: number;
  maxSpendAtomic: bigint;
  pricePerTickAtomic: bigint;
}>;

export function createLedger(maxSpendAtomic: bigint, pricePerTickAtomic: bigint): SpendLedger {
  return Object.freeze({ spentAtomic: 0n, tickCount: 0, maxSpendAtomic, pricePerTickAtomic });
}

export function canAfford(ledger: SpendLedger): boolean {
  return ledger.spentAtomic + ledger.pricePerTickAtomic <= ledger.maxSpendAtomic;
}

export function recordTick(ledger: SpendLedger): SpendLedger {
  return Object.freeze({
    ...ledger,
    spentAtomic: ledger.spentAtomic + ledger.pricePerTickAtomic,
    tickCount: ledger.tickCount + 1,
  });
}
