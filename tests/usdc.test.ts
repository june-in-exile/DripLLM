import { describe, it, expect } from "vitest";
import { FUJI_USDC, atomicToUsd, formatUsd } from "../src/shared/usdc.js";

describe("FUJI_USDC", () => {
  it("EIP-712 domain name 是 'USD Coin' 而非 'USDC'", () => {
    expect(FUJI_USDC.name).toBe("USD Coin");
  });

  it("網路識別字為 CAIP-2 格式", () => {
    expect(FUJI_USDC.network).toBe("eip155:43113");
  });

  it("decimals 為 6", () => {
    expect(FUJI_USDC.decimals).toBe(6);
  });
});

describe("atomicToUsd", () => {
  it("1000 atomic = 0.001000", () => {
    expect(atomicToUsd(1000n)).toBe("0.001000");
  });

  it("0 atomic = 0.000000", () => {
    expect(atomicToUsd(0n)).toBe("0.000000");
  });

  it("整數部分正確", () => {
    expect(atomicToUsd(1234567n)).toBe("1.234567");
  });

  it("拒絕負值", () => {
    expect(() => atomicToUsd(-1n)).toThrow(/負/);
  });
});

describe("formatUsd", () => {
  it("去除尾端零", () => {
    expect(formatUsd(1000n)).toBe("$0.001");
  });

  it("零值保留一位小數", () => {
    expect(formatUsd(0n)).toBe("$0.0");
  });

  it("不因浮點數而失準", () => {
    expect(formatUsd(50000n)).toBe("$0.05");
  });
});
