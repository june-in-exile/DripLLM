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
  it("exposes health and batch-settlement supported metadata", async () => {
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

  it("forwards verify and settle and preserves the x402 wire response", async () => {
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

  it("returns 400 JSON when the required payload is missing, without leaking program exceptions", async () => {
    const app = createFacilitatorApp({
      getSupported: () => ({ kinds: [], extensions: [], signers: {} }),
      verify: async () => ({ isValid: true }),
      settle: async () => ({ success: true, transaction: "0x", network: "eip155:43113" }),
    });

    const res = await request(app).post("/verify").send({});

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "paymentPayload and paymentRequirements are required" });
  });

  it("returns 400 with the message when verify or settle throws, without leaking the stack trace", async () => {
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

  it("also returns 400 when settle is missing paymentRequirements", async () => {
    const app = createFacilitatorApp({
      getSupported: () => ({ kinds: [], extensions: [], signers: {} }),
      verify: async () => ({ isValid: true }),
      settle: async () => ({ success: true, transaction: "0x", network: "eip155:43113" }),
    });

    const res = await request(app).post("/settle").send({ paymentPayload });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("required");
  });
});

describe("the actually assembled facilitator (spec §10.1)", () => {
  // 0xff…ff exceeds the secp256k1 curve order, so it isn't a valid private key
  const key = `0x${"1".repeat(64)}` as const;
  const config = loadConfig({
    FACILITATOR_URL: "http://localhost:8080",
    FACILITATOR_PRIVATE_KEY: key,
    LLM_PROVIDER_ADDRESS: "0x1234567890123456789012345678901234567890",
    AGENT_PRIVATE_KEY: `0x${"a".repeat(64)}`,
  });

  it("/supported advertises batch-settlement, Fuji, and the facilitator's own receiverAuthorizer", async () => {
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

  it("signers must be real addresses — a null makes the resource server deem the whole payload invalid", async () => {
    const res = await request(createFacilitatorApp(buildFacilitator(config))).get("/supported");

    const signers = Object.values(res.body.signers as Record<string, unknown[]>).flat();
    expect(signers.length).toBeGreaterThan(0);
    for (const signer of signers) {
      expect(signer).toBe(privateKeyToAccount(key).address);
    }
  });
});
