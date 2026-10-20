import { describe, it, expect } from "vitest";
import { FUJI_USDC, atomicToUsd, formatUsd } from "../src/shared/usdc.js";

describe("FUJI_USDC", () => {
  it("EIP-712 domain name is 'USD Coin', not 'USDC'", () => {
    expect(FUJI_USDC.name).toBe("USD Coin");
  });

  it("network identifier is in CAIP-2 format", () => {
    expect(FUJI_USDC.network).toBe("eip155:43113");
  });

  it("decimals is 6", () => {
    expect(FUJI_USDC.decimals).toBe(6);
  });

  it("uses the deterministic batch-settlement contract address from x402 v2.25", () => {
    expect(FUJI_USDC.batchSettlementAddress).toBe(
      "0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003",
    );
    expect(FUJI_USDC.erc3009DepositCollectorAddress).toBe(
      "0x4020806089470a89826cB9fB1f4059150b550004",
    );
  });
});

describe("atomicToUsd", () => {
  it("1000 atomic = 0.001000", () => {
    expect(atomicToUsd(1000n)).toBe("0.001000");
  });

  it("0 atomic = 0.000000", () => {
    expect(atomicToUsd(0n)).toBe("0.000000");
  });

  it("integer part is correct", () => {
    expect(atomicToUsd(1234567n)).toBe("1.234567");
  });

  it("rejects negative values", () => {
    expect(() => atomicToUsd(-1n)).toThrow(/negative/);
  });
});

describe("formatUsd", () => {
  it("strips trailing zeros", () => {
    expect(formatUsd(1000n)).toBe("$0.001");
  });

  it("keeps one decimal place for zero", () => {
    expect(formatUsd(0n)).toBe("$0.0");
  });

  it("does not lose precision to floating point", () => {
    expect(formatUsd(50000n)).toBe("$0.05");
  });
});
