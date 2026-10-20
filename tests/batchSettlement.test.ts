import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { rm } from "node:fs/promises";
import { signVoucher } from "@x402/evm/batch-settlement/client";
import { startFakeFacilitator } from "./helpers/fakeFacilitator.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { buildApp } from "../src/server/routes.js";
import { createWallet } from "../src/agent/wallet.js";
import { payTick } from "../src/agent/heartbeat.js";

/** 300ms per tick, 120ms grace, 25ms sweep — the whole "pay → cut" cycle finishes within 1 second. */
const FAST = {
  CREDIT_PER_TICK_MS: "300",
  TOPUP_THRESHOLD_MS: "100",
  GRACE_MS: "120",
  CREDIT_EVENT_MS: "50",
  WATCHDOG_SWEEP_MS: "25",
  TOKEN_INTERVAL_MS: "20",
};

type VoucherPayload = {
  type: string;
  channelConfig: { payer: string; payerAuthorizer: string };
  voucher: { channelId: `0x${string}`; maxClaimableAmount: string; signature: `0x${string}` };
};

let fake: Awaited<ReturnType<typeof startFakeFacilitator>>;
let server: Server;
let shutdown: () => Promise<void>;
let config: AppConfig;
let wallet: ReturnType<typeof createWallet>;
let storageDir: string;

function baseConfig(port: number, dir: string, agentKey = "0x" + "a".repeat(64)): AppConfig {
  return loadConfig({
    ...FAST,
    SERVER_PORT: String(port),
    SERVER_BASE_URL: `http://localhost:${port}`,
    FACILITATOR_URL: fake.url,
    FACILITATOR_PRIVATE_KEY: "0x" + "f".repeat(64),
    AGENT_PRIVATE_KEY: agentKey,
    LLM_PROVIDER_ADDRESS: "0x1234567890123456789012345678901234567890",
    CHANNEL_STORAGE_DIR: dir,
    DEPOSIT_ATOMIC: "400",
    DEPOSIT_TOPUP_ATOMIC: "200",
  });
}

beforeAll(async () => {
  fake = await startFakeFacilitator();
  storageDir = `/tmp/dripllm-batch-${crypto.randomUUID()}`;
  config = baseConfig(4300 + Math.floor(Math.random() * 300), storageDir);
  const built = await buildApp(config);
  shutdown = built.shutdown;
  await new Promise<void>((resolve) => {
    server = built.app.listen(config.serverPort, () => resolve());
  });
  wallet = createWallet(config);
});

afterAll(async () => {
  server.close();
  await shutdown();
  await fake.close();
  await rm(storageDir, { recursive: true, force: true });
});

/** Fetches the server-augmented requirements (with receiverAuthorizer and withdrawDelay) from an unpaid 402. */
async function fetchAccepted(): Promise<Record<string, unknown>> {
  const res = await fetch(`${config.serverBaseUrl}/tick`, {
    method: "POST",
    headers: { "X-Drip-Session": "probe" },
  });
  expect(res.status).toBe(402);
  const encoded = res.headers.get("payment-required");
  if (!encoded) throw new Error("402 missing PAYMENT-REQUIRED header");
  const decoded = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as {
    accepts: Record<string, unknown>[];
  };
  const accepted = decoded.accepts[0];
  if (!accepted) throw new Error("402 has no accepts");
  return accepted;
}

/** Signs the voucher due right now with the real client scheme, then hands it to the caller to tamper with. */
async function buildVoucher(accepted: Record<string, unknown>): Promise<VoucherPayload> {
  const built = await wallet.scheme.createPaymentPayload(2, accepted as never, undefined);
  return built.payload as VoucherPayload;
}

async function postPayload(
  sessionId: string,
  accepted: Record<string, unknown>,
  payload: unknown,
): Promise<Response> {
  const header = Buffer.from(
    JSON.stringify({ x402Version: 2, accepted, payload }),
    "utf8",
  ).toString("base64");
  return fetch(`${config.serverBaseUrl}/tick`, {
    method: "POST",
    headers: {
      "X-Drip-Session": sessionId,
      "PAYMENT-SIGNATURE": header,
      "Content-Type": "application/json",
    },
    body: "{}",
  });
}

/** A 402's rejection reason is in the PAYMENT-REQUIRED header, not the body. */
function rejectionReason(res: Response): string {
  const encoded = res.headers.get("payment-required");
  if (!encoded) return "";
  const decoded = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as {
    error?: string;
  };
  return decoded.error ?? "";
}

/** A rejected tick must leave no session behind — no session, no tokens (spec §7). */
async function expectNoSession(sessionId: string): Promise<void> {
  const stream = await fetch(`${config.serverBaseUrl}/stream`, {
    headers: { "X-Drip-Session": sessionId },
  });
  expect(stream.status).toBe(404);
  await stream.body?.cancel();
}

function parseSse(text: string): Array<{ event: string; data: string }> {
  return text
    .split("\n\n")
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice("event: ".length);
        else if (line.startsWith("data: ")) data += line.slice("data: ".length);
      }
      return { event, data };
    });
}

describe("batch-settlement billing layer (real voucher signatures + bookkeeping fake facilitator)", () => {
  it("extends paidUntil on every tick while the deposit suffices, and only the first tick goes on-chain", async () => {
    const sessionId = crypto.randomUUID();
    const first = await payTick(wallet, config, sessionId);
    expect(first.txHash).toBeTruthy();

    const second = await payTick(wallet, config, sessionId);
    const third = await payTick(wallet, config, sessionId);
    // The second and third ticks are off-chain vouchers: no transaction, but the cap rises by exactly one tick each time (spec §2.4)
    expect(second.txHash).toBeFalsy();
    expect(third.txHash).toBeFalsy();
    expect(BigInt(third.signedCeiling!) - BigInt(second.signedCeiling!)).toBe(
      config.pricePerTickAtomic,
    );

    const health = await fetch(`${config.serverBaseUrl}/health`).then((r) => r.json());
    expect(health.sessions).toBeGreaterThanOrEqual(1);
  });

  it("receives cut within the CREDIT + GRACE + SWEEP bound after payment stops", async () => {
    const sessionId = crypto.randomUUID();
    await payTick(wallet, config, sessionId);

    const started = Date.now();
    const res = await fetch(`${config.serverBaseUrl}/stream`, {
      headers: { "X-Drip-Session": sessionId },
    });
    expect(res.status).toBe(200);
    const body = await res.text();
    const elapsed = Date.now() - started;

    const frames = parseSse(body);
    expect(frames.some((f) => f.event === "token")).toBe(true);
    const cut = frames.filter((f) => f.event === "cut");
    expect(cut).toHaveLength(1);
    expect(JSON.parse(cut[0]!.data).reason).toBe("payment_lapsed");

    // Theoretical bound = remaining credit + grace + one sweep cycle. 400ms of slack for scheduling jitter.
    const bound = config.creditPerTickMs + config.graceMs + config.watchdogSweepMs + 400;
    expect(elapsed).toBeLessThan(bound);
  });

  it("stopping right after a top-up is the worst case: remaining credit exceeds one tick, so the bound adds TOPUP_THRESHOLD (spec §12.9)", async () => {
    const sessionId = crypto.randomUUID();
    await payTick(wallet, config, sessionId);
    // Wait until remaining credit nears the top-up threshold before paying the next tick — remaining after top-up = one tick + what was left at top-up, more than one tick.
    await new Promise((r) => setTimeout(r, config.creditPerTickMs - config.topupThresholdMs));
    await payTick(wallet, config, sessionId);

    const started = Date.now();
    const res = await fetch(`${config.serverBaseUrl}/stream`, {
      headers: { "X-Drip-Session": sessionId },
    });
    const frames = parseSse(await res.text());
    const elapsed = Date.now() - started;

    expect(frames.filter((f) => f.event === "cut")).toHaveLength(1);
    // Time to cut exceeds one tick, disproving the old "0-1 ticks remaining" assumption.
    expect(elapsed).toBeGreaterThan(config.creditPerTickMs);
    const bound =
      config.creditPerTickMs + config.topupThresholdMs + config.graceMs + config.watchdogSweepMs + 400;
    expect(elapsed).toBeLessThan(bound);
  });

  it("returns 402 and creates no session when the deposit is exhausted and the buyer doesn't top it up", async () => {
    // A dedicated buyer key = a dedicated channelId, so other cases' deposits are untouched.
    // A 120 atomic deposit = 3 ticks; the 4th tick's cap exceeds the balance and must be blocked by the seller.
    const poorConfig = baseConfig(config.serverPort, storageDir, "0x" + "b".repeat(64));
    const poor = createWallet(poorConfig, {
      depositStrategy: ({ currentBalance }) =>
        BigInt(currentBalance) === 0n ? "120" : false,
    });

    const statuses: number[] = [];
    let lastReason = "";
    let lastSessionId = "";
    for (let i = 0; i < 4; i++) {
      lastSessionId = crypto.randomUUID();
      const res = await poor.paidFetch(`${poorConfig.serverBaseUrl}/tick`, {
        method: "POST",
        headers: { "X-Drip-Session": lastSessionId, "Content-Type": "application/json" },
        body: "{}",
      });
      statuses.push(res.status);
      lastReason = rejectionReason(res);
      await res.text();
    }

    expect(statuses).toEqual([200, 200, 200, 402]);
    expect(lastReason).toContain("cumulative_exceeds_balance");
    await expectNoSession(lastSessionId);
  });

  it("rejects the tick and creates no session when the cap is tampered to mismatch the cumulative base", async () => {
    const accepted = await fetchAccepted();
    const voucher = await buildVoucher(accepted);
    // The server requires the cap to be exactly "consumed + one tick"; signing one extra tick is rejected too (spec §2.4)
    const inflated = BigInt(voucher.voucher.maxClaimableAmount) + config.pricePerTickAtomic;
    const signature = await signVoucher(
      wallet.signer as never,
      voucher.voucher.channelId,
      inflated.toString(),
      String(accepted.network),
    );

    const sessionId = crypto.randomUUID();
    const res = await postPayload(sessionId, accepted, {
      ...voucher,
      voucher: { ...voucher.voucher, ...signature, maxClaimableAmount: inflated.toString() },
    });

    expect(res.status).toBe(402);
    expect(rejectionReason(res)).toContain("cumulative_amount_mismatch");
    await expectNoSession(sessionId);
  });

  it("rejects the tick when the cap doesn't increase (replaying the previous voucher)", async () => {
    const accepted = await fetchAccepted();
    const voucher = await buildVoucher(accepted);
    // One tick back = equal to the chargedCumulativeAmount the server already recorded, i.e. no new credit added
    const stale = BigInt(voucher.voucher.maxClaimableAmount) - config.pricePerTickAtomic;
    const signature = await signVoucher(
      wallet.signer as never,
      voucher.voucher.channelId,
      stale.toString(),
      String(accepted.network),
    );

    const sessionId = crypto.randomUUID();
    const res = await postPayload(sessionId, accepted, {
      ...voucher,
      voucher: { ...voucher.voucher, ...signature, maxClaimableAmount: stale.toString() },
    });

    expect(res.status).toBe(402);
    expect(rejectionReason(res)).toContain("cumulative_amount_mismatch");
    await expectNoSession(sessionId);
  });

  it("rejects the tick when the signature is invalid", async () => {
    const accepted = await fetchAccepted();
    const voucher = await buildVoucher(accepted);
    const original = voucher.voucher.signature;
    const flipped = (original.slice(0, -2) +
      (original.slice(-2) === "1b" ? "1c" : "1b")) as `0x${string}`;

    const sessionId = crypto.randomUUID();
    const res = await postPayload(sessionId, accepted, {
      ...voucher,
      voucher: { ...voucher.voucher, signature: flipped },
    });

    expect(res.status).toBe(402);
    expect(rejectionReason(res)).toContain("voucher_signature");
    await expectNoSession(sessionId);
  });

  it("after a server restart the channel is restored from storage, and paying on needs no new deposit", async () => {
    const restartPort = config.serverPort + 500;
    const restarted = await buildApp(baseConfig(restartPort, storageDir));
    const restartedServer = await new Promise<Server>((resolve) => {
      const s = restarted.app.listen(restartPort, () => resolve(s));
    });

    try {
      const restartedConfig = baseConfig(restartPort, storageDir);
      const before = fake.settleCount();
      const result = await payTick(wallet, restartedConfig, crypto.randomUUID());

      // Evidence of restoration: no new deposit transaction, and the facilitator was never asked to settle
      expect(result.txHash).toBeFalsy();
      expect(fake.settleCount()).toBe(before);
    } finally {
      restartedServer.close();
      await restarted.shutdown();
    }
  });
});
