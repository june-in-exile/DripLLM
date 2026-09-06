import { describe, it, expect } from "vitest";
import { loadConfig, ConfigError } from "../src/config.js";

const valid = {
  FACILITATOR_URL: "http://localhost:8080",
  PAY_TO_ADDRESS: "0x1234567890123456789012345678901234567890",
  AGENT_PRIVATE_KEY: "0x" + "a".repeat(64),
};

describe("loadConfig", () => {
  it("以預設值補齊未指定的參數", () => {
    const c = loadConfig(valid);
    expect(c.creditPerTickMs).toBeGreaterThan(0);
    expect(c.pricePerTickAtomic).toBe(1000n);
  });

  it("一次列出全部缺漏項,而非只報第一個", () => {
    try {
      loadConfig({});
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const msg = (e as ConfigError).message;
      expect(msg).toContain("FACILITATOR_URL");
      expect(msg).toContain("PAY_TO_ADDRESS");
      expect(msg).toContain("AGENT_PRIVATE_KEY");
    }
  });

  it("拒絕格式錯誤的地址", () => {
    expect(() => loadConfig({ ...valid, PAY_TO_ADDRESS: "not-an-address" }))
      .toThrow(ConfigError);
  });

  it("拒絕 TOPUP_THRESHOLD_MS >= CREDIT_PER_TICK_MS", () => {
    expect(() =>
      loadConfig({ ...valid, CREDIT_PER_TICK_MS: "2000", TOPUP_THRESHOLD_MS: "2000" }),
    ).toThrow(/TOPUP_THRESHOLD_MS/);
  });

  it("金額以 bigint 表示,不用 number", () => {
    const c = loadConfig({ ...valid, MAX_SPEND_ATOMIC: "50000" });
    expect(typeof c.maxSpendAtomic).toBe("bigint");
  });
});
