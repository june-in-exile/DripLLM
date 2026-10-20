import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { startFakeFacilitator } from "./helpers/fakeFacilitator.js";
import { loadConfig } from "../src/config.js";
import { buildApp } from "../src/server/routes.js";
import { createWallet } from "../src/agent/wallet.js";
import { payTick, SessionCutError } from "../src/agent/heartbeat.js";
import { createSseParser } from "../src/agent/sse.js";

let fake: Awaited<ReturnType<typeof startFakeFacilitator>>;
let server: Server;
let shutdown: () => Promise<void>;
let baseUrl: string;
let config: ReturnType<typeof loadConfig>;

beforeAll(async () => {
  fake = await startFakeFacilitator();
  const port = 4100 + Math.floor(Math.random() * 500);
  config = loadConfig({
    CREDIT_PER_TICK_MS: "300",
    TOPUP_THRESHOLD_MS: "100",
    GRACE_MS: "120",
    CREDIT_EVENT_MS: "40",
    WATCHDOG_SWEEP_MS: "25",
    TOKEN_INTERVAL_MS: "20",
    SERVER_PORT: String(port),
    SERVER_BASE_URL: `http://localhost:${port}`,
    FACILITATOR_URL: fake.url,
    FACILITATOR_PRIVATE_KEY: "0x" + "f".repeat(64),
    CHANNEL_STORAGE_DIR: `/tmp/dripllm-e2e-${crypto.randomUUID()}`,
    LLM_PROVIDER_ADDRESS: "0x1234567890123456789012345678901234567890",
    AGENT_PRIVATE_KEY: "0x" + "a".repeat(64),
  });
  baseUrl = config.serverBaseUrl;
  const built = await buildApp(config);
  shutdown = built.shutdown;
  server = await new Promise((r) => {
    const s = built.app.listen(port, () => r(s));
  });
});

afterAll(async () => {
  await new Promise((r) => server.close(() => r(null)));
  await shutdown();
  await fake.close();
});

describe("full flow: pay → stream → stop paying → cut", () => {
  it("after payment the session is created, and SSE opens and receives token and credit", async () => {
    const wallet = createWallet(config);
    const id = crypto.randomUUID();
    const paid = await payTick(wallet, config, id);
    expect(paid.txHash).toMatch(/^0xfaketx/);

    const res = await fetch(`${baseUrl}/stream`, {
      headers: { "X-Drip-Session": paid.sessionId },
    });
    expect(res.status).toBe(200);

    const parse = createSseParser();
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const seen = new Set<string>();

    while (seen.size < 3) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const f of parse(decoder.decode(value, { stream: true }))) seen.add(f.event);
    }

    expect(seen.has("token")).toBe(true);
    expect(seen.has("credit")).toBe(true);
    expect(seen.has("cut")).toBe(true); // no top-up, so cut after the grace period
  }, 10_000);

  it("a second SSE for the same sessionId is rejected (409)", async () => {
    const wallet = createWallet(config);
    const id = crypto.randomUUID();
    const paid = await payTick(wallet, config, id);

    const first = await fetch(`${baseUrl}/stream`, {
      headers: { "X-Drip-Session": paid.sessionId },
    });
    expect(first.status).toBe(200);
    const second = await fetch(`${baseUrl}/stream`, {
      headers: { "X-Drip-Session": paid.sessionId },
    });
    expect(second.status).toBe(409);
    await first.body?.cancel();
  }, 10_000);

  it("paying again with a cut sessionId returns 409 and the settlement is cancelled (no charge)", async () => {
    const wallet = createWallet(config);
    const id = crypto.randomUUID();
    await payTick(wallet, config, id);

    // wait until cut (credit 300ms + grace 120ms + sweep 25ms)
    await new Promise((r) => setTimeout(r, 600));

    const before = fake.settleCount();
    await expect(payTick(wallet, config, id)).rejects.toThrow(SessionCutError);
    // handler returns 409 → middleware cancels settlement → settle count doesn't increase
    expect(fake.settleCount()).toBe(before);
  }, 10_000);

  it("the cut event carries correct tickCount and spentAtomic, with no undefined", async () => {
    const wallet = createWallet(config);
    const id = crypto.randomUUID();
    const paid = await payTick(wallet, config, id);

    const res = await fetch(`${baseUrl}/stream`, {
      headers: { "X-Drip-Session": paid.sessionId },
    });
    const parse = createSseParser();
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    let cut: { tickCount: number; spentAtomic: string } | null = null;
    while (!cut) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const f of parse(decoder.decode(value, { stream: true }))) {
        if (f.event === "cut") cut = JSON.parse(f.data);
      }
    }

    expect(cut).not.toBeNull();
    expect(cut!.tickCount).toBe(1);
    expect(cut!.spentAtomic).toBe(config.pricePerTickAtomic.toString());
  }, 10_000);
});
