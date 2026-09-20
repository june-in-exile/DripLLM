import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { rm } from "node:fs/promises";
import { startFakeFacilitator } from "./helpers/fakeFacilitator.js";
import { loadConfig } from "../src/config.js";
import { buildApp } from "../src/server/routes.js";
import { createWallet } from "../src/agent/wallet.js";
import { payTick } from "../src/agent/heartbeat.js";

let fake: Awaited<ReturnType<typeof startFakeFacilitator>>;
let server: Server;
let shutdown: () => Promise<void>;
let baseUrl: string;
let config: ReturnType<typeof loadConfig>;
let channelStorageDir: string;

beforeAll(async () => {
  fake = await startFakeFacilitator();
  const port = 4200 + Math.floor(Math.random() * 500);
  channelStorageDir = `/tmp/dripllm-wallet-${crypto.randomUUID()}`;
  config = loadConfig({
    SERVER_PORT: String(port),
    SERVER_BASE_URL: `http://localhost:${port}`,
    FACILITATOR_URL: fake.url,
    FACILITATOR_PRIVATE_KEY: "0x" + "f".repeat(64),
    AGENT_PRIVATE_KEY: "0x" + "a".repeat(64),
    CHANNEL_STORAGE_DIR: channelStorageDir,
    LLM_PROVIDER_ADDRESS: "0x1234567890123456789012345678901234567890",
    PRICE_PER_TICK_ATOMIC: "40",
    DEPOSIT_ATOMIC: "50000",
  });
  baseUrl = config.serverBaseUrl;

  const built = await buildApp(config);
  shutdown = built.shutdown;
  await new Promise<void>((resolve) => {
    server = built.app.listen(port, () => resolve());
  });
});

afterAll(async () => {
  server.close();
  await shutdown();
  await fake.close();
  await rm(channelStorageDir, { recursive: true, force: true });
});

describe("wallet", () => {
  it("two consecutive payments are deposit then voucher and cumulative allowance rises by exactly 40 atomic", async () => {
    const wallet = createWallet(config);
    const sessionId = crypto.randomUUID();

    // First payment: should be a deposit
    const r1 = await payTick(wallet, config, sessionId);
    expect(r1.txHash).toBeDefined();
    expect(r1.signedCeiling).toBeDefined();
    
    const ceiling1 = BigInt(r1.signedCeiling!);

    // Second payment: should be a voucher (no new transaction)
    const r2 = await payTick(wallet, config, sessionId);
    expect(r2.txHash).toBeFalsy();
    expect(r2.signedCeiling).toBeDefined();

    const ceiling2 = BigInt(r2.signedCeiling!);

    expect(ceiling2 - ceiling1).toBe(40n);
  });
});

describe("client signer 的能力", () => {
  it("必須具備 readContract —— 沒有它,退款後與鏈上失步就永遠卡在 402(spec §7)", () => {
    const wallet = createWallet(config);
    expect(typeof wallet.signer.readContract).toBe("function");
    expect(wallet.signer.address).toBe(wallet.account.address);
  });
});
