import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";
import { rm } from "node:fs/promises";
import { signVoucher } from "@x402/evm/batch-settlement/client";
import { startFakeFacilitator } from "./helpers/fakeFacilitator.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { buildApp } from "../src/server/routes.js";
import { createWallet } from "../src/agent/wallet.js";
import { payTick } from "../src/agent/heartbeat.js";

/** 一格 300ms、寬限 120ms、掃描 25ms —— 整個「付款 → 剪線」週期 1 秒內跑完。 */
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

/** 從未付款的 402 取回 server 增補過的 requirements(含 receiverAuthorizer 與 withdrawDelay)。 */
async function fetchAccepted(): Promise<Record<string, unknown>> {
  const res = await fetch(`${config.serverBaseUrl}/tick`, {
    method: "POST",
    headers: { "X-Drip-Session": "probe" },
  });
  expect(res.status).toBe(402);
  const encoded = res.headers.get("payment-required");
  if (!encoded) throw new Error("402 缺少 PAYMENT-REQUIRED header");
  const decoded = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as {
    accepts: Record<string, unknown>[];
  };
  const accepted = decoded.accepts[0];
  if (!accepted) throw new Error("402 沒有任何 accepts");
  return accepted;
}

/** 用真實 client scheme 簽一張當下該簽的 voucher,再交給呼叫端動手腳。 */
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

/** 402 的拒絕原因放在 PAYMENT-REQUIRED header,不在 body。 */
function rejectionReason(res: Response): string {
  const encoded = res.headers.get("payment-required");
  if (!encoded) return "";
  const decoded = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as {
    error?: string;
  };
  return decoded.error ?? "";
}

/** 被拒絕的一格不得留下任何 session —— 沒有 session 就送不出 token(spec §7)。 */
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

describe("batch-settlement 收費層(真實 voucher 簽章 + 記帳假 facilitator)", () => {
  it("押金足夠時每格都延長 paidUntil,且只有第一格上鏈", async () => {
    const sessionId = crypto.randomUUID();
    const first = await payTick(wallet, config, sessionId);
    expect(first.txHash).toBeTruthy();

    const second = await payTick(wallet, config, sessionId);
    const third = await payTick(wallet, config, sessionId);
    // 第二、三格是鏈下 voucher:沒有交易,但上限每格剛好加一格(spec §2.4)
    expect(second.txHash).toBeFalsy();
    expect(third.txHash).toBeFalsy();
    expect(BigInt(third.signedCeiling!) - BigInt(second.signedCeiling!)).toBe(
      config.pricePerTickAtomic,
    );

    const health = await fetch(`${config.serverBaseUrl}/health`).then((r) => r.json());
    expect(health.sessions).toBeGreaterThanOrEqual(1);
  });

  it("停付後在 CREDIT + GRACE + SWEEP 的上界內收到 cut", async () => {
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

    // 理論上界 = 剩餘額度 + 寬限 + 一個 sweep 週期。留 400ms 給排程抖動。
    const bound = config.creditPerTickMs + config.graceMs + config.watchdogSweepMs + 400;
    expect(elapsed).toBeLessThan(bound);
  });

  it("押金耗盡且買方不再補押金時回 402 且不建立 session", async () => {
    // 專屬的買方金鑰 = 專屬的 channelId,才不會動到其他案例的押金。
    // 押金 120 atomic = 3 格;第 4 格的上限就會超過餘額,必須被賣方擋下。
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

  it("上限被竄改為與累計基準不符時拒絕該格,不建立 session", async () => {
    const accepted = await fetchAccepted();
    const voucher = await buildVoucher(accepted);
    // server 要求上限剛好等於「已消耗 + 一格」,多簽一格也不行(spec §2.4)
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

  it("上限未遞增(重放上一張 voucher)時拒絕該格", async () => {
    const accepted = await fetchAccepted();
    const voucher = await buildVoucher(accepted);
    // 退回一格 = 與 server 已記的 chargedCumulativeAmount 相同,等於沒有加新額度
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

  it("簽章無效時拒絕該格", async () => {
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

  it("server 重啟後 channel 從 storage 復原,續付不需要重新存押金", async () => {
    const restartPort = config.serverPort + 500;
    const restarted = await buildApp(baseConfig(restartPort, storageDir));
    const restartedServer = await new Promise<Server>((resolve) => {
      const s = restarted.app.listen(restartPort, () => resolve(s));
    });

    try {
      const restartedConfig = baseConfig(restartPort, storageDir);
      const before = fake.settleCount();
      const result = await payTick(wallet, restartedConfig, crypto.randomUUID());

      // 復原成功的證據:沒有新的 deposit 交易,facilitator 也沒被呼叫 settle
      expect(result.txHash).toBeFalsy();
      expect(fake.settleCount()).toBe(before);
    } finally {
      restartedServer.close();
      await restarted.shutdown();
    }
  });
});
