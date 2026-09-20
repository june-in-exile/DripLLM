import { describe, it, expect } from "vitest";
import { loadConfig, ConfigError } from "../src/config.js";

const valid = {
  FACILITATOR_URL: "http://localhost:8080",
  FACILITATOR_PRIVATE_KEY: "0x" + "f".repeat(64),
  LLM_PROVIDER_ADDRESS: "0x1234567890123456789012345678901234567890",
  AGENT_PRIVATE_KEY: "0x" + "a".repeat(64),
};

describe("loadConfig", () => {
  it("以預設值補齊未指定的參數", () => {
    const c = loadConfig(valid);
    expect(c.creditPerTickMs).toBe(1_000);
    expect(c.topupThresholdMs).toBe(300);
    expect(c.graceMs).toBe(250);
    expect(c.pricePerTickAtomic).toBe(40n);
    expect(c.watchdogSweepMs).toBe(100);
    expect(c.depositAtomic).toBe(50_000n);
    expect(c.depositTopupAtomic).toBe(5_000n);
    expect(c.withdrawDelaySecs).toBe(900);
    expect(c.claimIntervalSecs).toBe(60);
    expect(c.settleIntervalSecs).toBe(300);
    expect(c.refundIdleSecs).toBe(120);
    expect(c.maxClaimsPerBatch).toBe(20);
  });

  it("一次列出全部缺漏項,而非只報第一個", () => {
    try {
      loadConfig({});
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ConfigError);
      const msg = (e as ConfigError).message;
      expect(msg).toContain("FACILITATOR_URL");
      expect(msg).toContain("FACILITATOR_PRIVATE_KEY");
      expect(msg).toContain("LLM_PROVIDER_ADDRESS");
      expect(msg).toContain("AGENT_PRIVATE_KEY");
    }
  });

  it("拒絕格式錯誤的地址", () => {
    expect(() => loadConfig({ ...valid, LLM_PROVIDER_ADDRESS: "not-an-address" }))
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

  it("拒絕 withdraw delay 沒有大於 claim interval", () => {
    expect(() =>
      loadConfig({ ...valid, WITHDRAW_DELAY_SECS: "60", CLAIM_INTERVAL_SECS: "60" }),
    ).toThrow(/WITHDRAW_DELAY_SECS/);
  });

  it("拒絕提領輪詢比提領延遲還慢 —— 那樣插隊 claim 永遠來不及", () => {
    expect(() =>
      loadConfig({ ...valid, WITHDRAW_DELAY_SECS: "120", WITHDRAW_POLL_MS: "120000" }),
    ).toThrow(/WITHDRAW_POLL_MS/);
  });

  it("賣方授權私鑰是選填的,留空代表委派 facilitator 簽 claim 授權", () => {
    expect(loadConfig(valid).llmProviderAuthorizerPrivateKey).toBeUndefined();
    const key = `0x${"c".repeat(64)}`;
    expect(
      loadConfig({ ...valid, LLM_PROVIDER_AUTHORIZER_PRIVATE_KEY: key })
        .llmProviderAuthorizerPrivateKey,
    ).toBe(key);
  });

  it("提領輪詢間隔有預設值,不必在 .env 指定", () => {
    expect(loadConfig(valid).withdrawPollMs).toBe(5_000);
  });
});
