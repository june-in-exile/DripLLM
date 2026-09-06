export const FUJI_USDC = Object.freeze({
  network: "eip155:43113" as const,
  address: "0x5425890298aed601595a70AB815c96711a31Bc65" as const,
  // EIP-712 domain。此兩值由 Fuji 鏈上 eth_call 讀出,勿改。
  name: "USD Coin" as const,
  version: "2" as const,
  decimals: 6 as const,
});

export function atomicToUsd(atomic: bigint): string {
  if (atomic < 0n) throw new RangeError("金額不可為負值");
  const scale = 10n ** BigInt(FUJI_USDC.decimals);
  const whole = atomic / scale;
  const frac = (atomic % scale).toString().padStart(FUJI_USDC.decimals, "0");
  return `${whole}.${frac}`;
}

export function formatUsd(atomic: bigint): string {
  const raw = atomicToUsd(atomic);
  const trimmed = raw.replace(/0+$/, "");
  return `$${trimmed.endsWith(".") ? trimmed + "0" : trimmed}`;
}
