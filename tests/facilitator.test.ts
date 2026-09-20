import { describe, expect, it } from "vitest";
import request from "supertest";
import { privateKeyToAccount } from "viem/accounts";
import { createFacilitatorApp } from "../src/facilitator/app.js";
import { buildFacilitator } from "../src/facilitator/facilitator.js";
import { loadConfig } from "../src/config.js";

const requirements = {
  scheme: "batch-settlement",
  network: "eip155:43113",
  amount: "40",
  asset: "0x5425890298aed601595a70AB815c96711a31Bc65",
  payTo: "0x2222222222222222222222222222222222222222",
  maxTimeoutSeconds: 60,
  extra: {},
};
const paymentPayload = {
  x402Version: 2,
  accepted: requirements,
  payload: { type: "voucher" },
};

describe("self-hosted facilitator HTTP adapter", () => {
  it("提供 health 與 batch-settlement supported metadata", async () => {
    const app = createFacilitatorApp({
      getSupported: () => ({
        kinds: [{ x402Version: 2, scheme: "batch-settlement", network: "eip155:43113" }],
        extensions: [],
        signers: {},
      }),
      verify: async () => ({ isValid: true }),
      settle: async () => ({ success: true, transaction: "0xtx", network: "eip155:43113" }),
    });

    const health = await request(app).get("/health");
    const supported = await request(app).get("/supported");

    expect(health.status).toBe(200);
    expect(health.body).toEqual({ ok: true });
    expect(supported.body.kinds[0]).toMatchObject({ scheme: "batch-settlement" });
  });

  it("轉送 verify 與 settle 並保持 x402 wire response", async () => {
    const app = createFacilitatorApp({
      getSupported: () => ({ kinds: [], extensions: [], signers: {} }),
      verify: async () => ({ isValid: true, payer: "0x1111111111111111111111111111111111111111" }),
      settle: async () => ({
        success: true,
        payer: "0x1111111111111111111111111111111111111111",
        transaction: "0xsettled",
        network: "eip155:43113",
      }),
    });

    const verify = await request(app).post("/verify").send({ paymentPayload, paymentRequirements: requirements });
    const settle = await request(app).post("/settle").send({ paymentPayload, paymentRequirements: requirements });

    expect(verify.status).toBe(200);
    expect(verify.body).toMatchObject({ isValid: true });
    expect(settle.status).toBe(200);
    expect(settle.body).toMatchObject({ success: true, transaction: "0xsettled" });
  });

  it("缺少必要 payload 時回 400 JSON,不把程式例外洩漏出去", async () => {
    const app = createFacilitatorApp({
      getSupported: () => ({ kinds: [], extensions: [], signers: {} }),
      verify: async () => ({ isValid: true }),
      settle: async () => ({ success: true, transaction: "0x", network: "eip155:43113" }),
    });

    const res = await request(app).post("/verify").send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "paymentPayload 與 paymentRequirements 為必填" });
  });

  it("verify 或 settle 拋錯時回 400 與訊息,不讓 stack trace 外洩", async () => {
    const app = createFacilitatorApp({
      getSupported: () => ({ kinds: [], extensions: [], signers: {} }),
      verify: async () => {
        throw new Error("rpc unreachable");
      },
      settle: async () => {
        throw new Error("nonce too low");
      },
    });

    const verify = await request(app)
      .post("/verify")
      .send({ paymentPayload, paymentRequirements: requirements });
    const settle = await request(app)
      .post("/settle")
      .send({ paymentPayload, paymentRequirements: requirements });

    expect(verify.status).toBe(400);
    expect(verify.body).toEqual({ error: "rpc unreachable" });
    expect(settle.status).toBe(400);
    expect(settle.body).toEqual({ error: "nonce too low" });
  });

  it("settle 缺 paymentRequirements 時同樣回 400", async () => {
    const app = createFacilitatorApp({
      getSupported: () => ({ kinds: [], extensions: [], signers: {} }),
      verify: async () => ({ isValid: true }),
      settle: async () => ({ success: true, transaction: "0x", network: "eip155:43113" }),
    });

    const res = await request(app).post("/settle").send({ paymentPayload });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("必填");
  });
});

describe("真正組起來的 facilitator(spec §10.1)", () => {
  // 0xff…ff 超過 secp256k1 的曲線階,不是合法私鑰
  const key = `0x${"1".repeat(64)}` as const;
  const config = loadConfig({
    FACILITATOR_URL: "http://localhost:8080",
    FACILITATOR_PRIVATE_KEY: key,
    LLM_PROVIDER_ADDRESS: "0x1234567890123456789012345678901234567890",
    AGENT_PRIVATE_KEY: `0x${"a".repeat(64)}`,
  });

  it("/supported 廣告 batch-settlement、Fuji,以及 facilitator 自己的 receiverAuthorizer", async () => {
    const res = await request(createFacilitatorApp(buildFacilitator(config))).get("/supported");

    expect(res.status).toBe(200);
    expect(res.body.kinds).toHaveLength(1);
    expect(res.body.kinds[0]).toMatchObject({
      x402Version: 2,
      scheme: "batch-settlement",
      network: "eip155:43113",
    });
    expect(res.body.kinds[0].extra.receiverAuthorizer).toBe(privateKeyToAccount(key).address);
  });

  it("signers 必須是真的位址 —— 出現 null 會讓 resource server 判定整份 payload 無效", async () => {
    const res = await request(createFacilitatorApp(buildFacilitator(config))).get("/supported");

    const signers = Object.values(res.body.signers as Record<string, unknown[]>).flat();
    expect(signers.length).toBeGreaterThan(0);
    for (const signer of signers) {
      expect(signer).toBe(privateKeyToAccount(key).address);
    }
  });
});
