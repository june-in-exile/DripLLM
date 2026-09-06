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
    PAY_TO_ADDRESS: "0x1234567890123456789012345678901234567890",
    AGENT_PRIVATE_KEY: "0x" + "a".repeat(64),
  });
  baseUrl = config.serverBaseUrl;
  const app = await buildApp(config);
  server = await new Promise((r) => {
    const s = app.listen(port, () => r(s));
  });
});

afterAll(async () => {
  await new Promise((r) => server.close(() => r(null)));
  await fake.close();
});

describe("完整流程:付款 → 串流 → 停付 → 剪線", () => {
  it("付款後 session 建立,SSE 開得起來並收到 token 與 credit", async () => {
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
    expect(seen.has("cut")).toBe(true); // 未補款,寬限期後被剪
  }, 10_000);

  it("同一 sessionId 的第二條 SSE 被拒(409)", async () => {
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

  it("被剪除的 sessionId 再次付款回 409,且結算被取消(未扣款)", async () => {
    const wallet = createWallet(config);
    const id = crypto.randomUUID();
    await payTick(wallet, config, id);

    // 等到被剪(credit 300ms + grace 120ms + sweep 25ms)
    await new Promise((r) => setTimeout(r, 600));

    const before = fake.settleCount();
    await expect(payTick(wallet, config, id)).rejects.toThrow(SessionCutError);
    // handler 回 409 → middleware 取消結算 → settle 次數不增加
    expect(fake.settleCount()).toBe(before);
  }, 10_000);

  it("cut 事件帶正確的 tickCount 與 spentAtomic,不含 undefined", async () => {
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
