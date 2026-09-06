import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { startFakeFacilitator } from "./helpers/fakeFacilitator.js";

// 極小常數:完整「付款 → 串流 → 斷流」週期在 1 秒內跑完
const FAST = {
  CREDIT_PER_TICK_MS: "300",
  TOPUP_THRESHOLD_MS: "100",
  GRACE_MS: "120",
  CREDIT_EVENT_MS: "50",
  WATCHDOG_SWEEP_MS: "25",
  TOKEN_INTERVAL_MS: "20",
};

const AGENT = "0x" + "b".repeat(40);
const OTHER_AGENT = "0x" + "c".repeat(40);

let fake: Awaited<ReturnType<typeof startFakeFacilitator>>;
let app: Express;

beforeAll(async () => {
  fake = await startFakeFacilitator();
  const { loadConfig } = await import("../src/config.js");
  const { buildApp } = await import("../src/server/routes.js");
  const config = loadConfig({
    ...FAST,
    FACILITATOR_URL: fake.url,
    PAY_TO_ADDRESS: "0x1234567890123456789012345678901234567890",
    AGENT_PRIVATE_KEY: "0x" + "a".repeat(64),
  });
  app = await buildApp(config);
});

afterAll(async () => {
  await fake.close();
});

/**
 * 從未付款 402 的 PAYMENT-REQUIRED header 取真實 requirements。
 * 假 facilitator 對 /verify 一律回 isValid:true(不做簽章驗證),
 * 所以 accepted 直接回聲 requirements 即可通過比對,不必簽名。
 */
async function fetchRequirements(): Promise<{ accepts: unknown[] }> {
  const res = await request(app).post("/tick").set("X-Drip-Session", "probe");
  expect(res.status).toBe(402);
  const encoded = res.headers["payment-required"];
  if (typeof encoded !== "string") throw new Error("402 缺少 PAYMENT-REQUIRED header");
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as { accepts: unknown[] };
}

function paymentHeader(requirements: { accepts: unknown[] }, from: string): string {
  const payload = {
    x402Version: 2,
    accepted: requirements.accepts[0],
    payload: { authorization: { from } },
  };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
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

describe("POST /tick —— 付款閘門", () => {
  it("未帶 X-PAYMENT 時回 402 並附上價格與資產", async () => {
    const res = await request(app).post("/tick").set("X-Drip-Session", "s1");
    expect(res.status).toBe(402);
    // v2.25.0 標準 wire format:付款要求放 PAYMENT-REQUIRED header(base64url JSON),
    // API client 的 body 預設為空物件(官方 client 讀 header,不讀 body)。
    expect(res.body).toEqual({});
    const encoded = res.headers["payment-required"];
    if (typeof encoded !== "string") throw new Error("402 缺少 PAYMENT-REQUIRED header");
    const required = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    const text = JSON.stringify(required);
    expect(text).toContain("eip155:43113");
    expect(text).toContain("0x5425890298aed601595a70AB815c96711a31Bc65");
  });
});

describe("GET /stream —— session 為門票", () => {
  it("未知 sessionId 回 404", async () => {
    const res = await request(app).get("/stream").query({ sessionId: "never-paid" });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/session/);
  });

  it("缺少 sessionId 參數回 400", async () => {
    const res = await request(app).get("/stream");
    expect(res.status).toBe(400);
  });
});

describe("GET /health", () => {
  it("回 200", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
  });
});

describe("付款 → session → SSE → 剪線(真實 middleware + 假 facilitator)", () => {
  it("帶 PAYMENT-SIGNATURE 的 /tick 完成結算,onAfterSettle 建立 session", async () => {
    const reqs = await fetchRequirements();
    const res = await request(app)
      .post("/tick")
      .set("X-Drip-Session", "paid-s1")
      .set("PAYMENT-SIGNATURE", paymentHeader(reqs, AGENT));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sessionId: "paid-s1", accepted: true });
    expect(fake.settleCount()).toBe(1);

    const health = await request(app).get("/health");
    expect(health.body.sessions).toBe(1);
  });

  it("未帶 X-Drip-Session 的付費 /tick 回 400 且不結算", async () => {
    const reqs = await fetchRequirements();
    const res = await request(app)
      .post("/tick")
      .set("PAYMENT-SIGNATURE", paymentHeader(reqs, AGENT));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/X-Drip-Session/);
    expect(fake.settleCount()).toBe(1);
  });

  it("同一 session 的第二條串流連線回 409", async () => {
    const reqs = await fetchRequirements();
    const paid = await request(app)
      .post("/tick")
      .set("X-Drip-Session", "paid-dup")
      .set("PAYMENT-SIGNATURE", paymentHeader(reqs, AGENT));
    expect(paid.status).toBe(200);
    expect(fake.settleCount()).toBe(2);

    // then() 觸發送出第一條,第二條在其存續期內到達
    const first = request(app).get("/stream").query({ sessionId: "paid-dup" });
    const firstDone = first.then((r) => r);
    const second = await request(app).get("/stream").query({ sessionId: "paid-dup" });
    expect(second.status).toBe(409);
    const firstRes = await firstDone;
    expect(firstRes.status).toBe(200);
  });

  it("停付後 watchdog 剪線:token/credit 有流,cut 附 tickCount 與 spentAtomic", async () => {
    const reqs = await fetchRequirements();
    const paid = await request(app)
      .post("/tick")
      .set("X-Drip-Session", "paid-cut")
      .set("PAYMENT-SIGNATURE", paymentHeader(reqs, AGENT));
    expect(paid.status).toBe(200);
    expect(fake.settleCount()).toBe(3);

    const res = await request(app).get("/stream").query({ sessionId: "paid-cut" });
    expect(res.status).toBe(200);
    expect(String(res.headers["content-type"])).toContain("text/event-stream");

    const frames = parseSse(res.text);
    expect(frames.some((f) => f.event === "token")).toBe(true);
    expect(frames.some((f) => f.event === "credit")).toBe(true);
    const cut = frames.filter((f) => f.event === "cut");
    expect(cut).toHaveLength(1);
    expect(JSON.parse(cut[0]!.data)).toEqual({
      sessionId: "paid-cut",
      reason: "payment_lapsed",
      tickCount: 1,
      spentAtomic: "1000",
    });
  });

  it("已剪除的 sessionId 再次付費回 409 且不結算", async () => {
    const reqs = await fetchRequirements();
    const res = await request(app)
      .post("/tick")
      .set("X-Drip-Session", "paid-cut")
      .set("PAYMENT-SIGNATURE", paymentHeader(reqs, AGENT));
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/剪除/);
    expect(fake.settleCount()).toBe(3);

    // 剪線後 session 已自帳本移除,stream 回 404
    const stream = await request(app).get("/stream").query({ sessionId: "paid-cut" });
    expect(stream.status).toBe(404);
  });

  it("串流中再付款:credit 即時反映新 tickCount(現讀 store)", async () => {
    const reqs = await fetchRequirements();
    const paid = await request(app)
      .post("/tick")
      .set("X-Drip-Session", "paid-ext")
      .set("PAYMENT-SIGNATURE", paymentHeader(reqs, AGENT));
    expect(paid.status).toBe(200);
    expect(fake.settleCount()).toBe(4);

    const stream = request(app).get("/stream").query({ sessionId: "paid-ext" });
    const streamDone = stream.then((r) => r);
    // 讓第一筆 tick 的串流先跑起來
    await new Promise((resolve) => setTimeout(resolve, 40));
    const extend = await request(app)
      .post("/tick")
      .set("X-Drip-Session", "paid-ext")
      .set("PAYMENT-SIGNATURE", paymentHeader(reqs, AGENT));
    expect(extend.status).toBe(200);
    expect(fake.settleCount()).toBe(5);

    const res = await streamDone;
    const frames = parseSse(res.text);
    const credits = frames.filter((f) => f.event === "credit").map((f) => JSON.parse(f.data));
    // 延長後 credit 必須反映 tick #2 —— 若 handler 閉包捕獲 store 會永遠停在 1
    expect(credits.some((c) => c.tickCount === 2)).toBe(true);
    const cut = frames.filter((f) => f.event === "cut");
    expect(cut).toHaveLength(1);
    expect(JSON.parse(cut[0]!.data).tickCount).toBe(2);
  });

  it("agent 主動斷線:session 仍留帳本,由 watchdog 後續清掃", async () => {
    const reqs = await fetchRequirements();
    const paid = await request(app)
      .post("/tick")
      .set("X-Drip-Session", "paid-abort")
      .set("PAYMENT-SIGNATURE", paymentHeader(reqs, AGENT));
    expect(paid.status).toBe(200);

    const stream = request(app).get("/stream").query({ sessionId: "paid-abort" });
    const done = stream.then(
      () => null,
      () => null,
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    stream.abort();
    await done;

    // 是 agent 自己斷的,不是 server 剪的 —— 付款仍有效,帳本還在
    const health = await request(app).get("/health");
    expect(health.body.sessions).toBe(1);
  });

  it("同 sessionId 換付款者:settle 成功但 session 不延長(payer_mismatch)", async () => {
    const reqs = await fetchRequirements();
    const first = await request(app)
      .post("/tick")
      .set("X-Drip-Session", "paid-mismatch")
      .set("PAYMENT-SIGNATURE", paymentHeader(reqs, OTHER_AGENT));
    expect(first.status).toBe(200);
    expect(fake.settleCount()).toBe(7);

    const hijack = await request(app)
      .post("/tick")
      .set("X-Drip-Session", "paid-mismatch")
      .set("PAYMENT-SIGNATURE", paymentHeader(reqs, AGENT));
    expect(hijack.status).toBe(200);
    expect(fake.settleCount()).toBe(8);

    // hook 拒絕延長:tickCount 仍是 1,spentAtomic 仍是第一次的 1000
    const res = await request(app).get("/stream").query({ sessionId: "paid-mismatch" });
    expect(res.status).toBe(200);
    const frames = parseSse(res.text);
    const cut = frames.filter((f) => f.event === "cut");
    expect(cut).toHaveLength(1);
    expect(JSON.parse(cut[0]!.data)).toMatchObject({ tickCount: 1, spentAtomic: "1000" });
  });
});
