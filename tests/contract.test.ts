import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import type { Express } from "express";
import { startFakeFacilitator } from "./helpers/fakeFacilitator.js";

// Tiny constants: the full "pay → stream → cut-off" cycle finishes within 1 second
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
let shutdown: () => Promise<void>;

beforeAll(async () => {
  fake = await startFakeFacilitator();
  const { loadConfig } = await import("../src/config.js");
  const { buildApp } = await import("../src/server/routes.js");
  const config = loadConfig({
    ...FAST,
    FACILITATOR_URL: fake.url,
    FACILITATOR_PRIVATE_KEY: "0x" + "f".repeat(64),
    CHANNEL_STORAGE_DIR: `/tmp/dripllm-contract-${crypto.randomUUID()}`,
    LLM_PROVIDER_ADDRESS: "0x1234567890123456789012345678901234567890",
    AGENT_PRIVATE_KEY: "0x" + "a".repeat(64),
  });
  const built = await buildApp(config);
  app = built.app;
  shutdown = built.shutdown;
});

afterAll(async () => {
  await shutdown();
  await fake.close();
});

/**
 * Fetches the real requirements from the PAYMENT-REQUIRED header of an unpaid 402.
 * The fake facilitator always answers /verify with isValid:true (no signature verification),
 * so accepted can just echo requirements to pass the comparison, no signing needed.
 */
async function fetchRequirements(): Promise<{ accepts: unknown[] }> {
  const res = await request(app).post("/tick").set("X-Drip-Session", "probe");
  expect(res.status).toBe(402);
  const encoded = res.headers["payment-required"];
  if (typeof encoded !== "string") throw new Error("402 missing PAYMENT-REQUIRED header");
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

describe("POST /tick — payment gate", () => {
  it("returns 402 with price and asset when X-PAYMENT is absent", async () => {
    const res = await request(app).post("/tick").set("X-Drip-Session", "s1");
    expect(res.status).toBe(402);
    // v2.25.0 standard wire format: payment requirements go in the PAYMENT-REQUIRED header (base64url JSON),
    // and the API client's body defaults to an empty object (the official client reads the header, not the body).
    expect(res.body).toEqual({});
    const encoded = res.headers["payment-required"];
    if (typeof encoded !== "string") throw new Error("402 missing PAYMENT-REQUIRED header");
    const required = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    const text = JSON.stringify(required);
    expect(text).toContain("batch-settlement");
    expect(text).not.toContain('"scheme":"exact"');
    expect(text).toContain("eip155:43113");
    expect(text).toContain("0x5425890298aed601595a70AB815c96711a31Bc65");
  });
});

describe("GET /stream — the session is the ticket", () => {
  it("returns 404 for an unknown sessionId", async () => {
    const res = await request(app).get("/stream").set("X-Drip-Session", "never-paid");
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/session/);
  });

  it("returns 400 when the X-Drip-Session header is missing", async () => {
    const res = await request(app).get("/stream");
    expect(res.status).toBe(400);
  });
});

describe("GET /health", () => {
  it("returns 200", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
  });
});

describe("pay → session → SSE → cut (real middleware + fake facilitator)", () => {
  it("a /tick with PAYMENT-SIGNATURE completes settlement and onAfterSettle creates the session", async () => {
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

  it("a paid /tick without X-Drip-Session returns 400 and doesn't settle", async () => {
    const reqs = await fetchRequirements();
    const res = await request(app)
      .post("/tick")
      .set("PAYMENT-SIGNATURE", paymentHeader(reqs, AGENT));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/X-Drip-Session/);
    expect(fake.settleCount()).toBe(1);
  });

  it("a second stream connection for the same session returns 409", async () => {
    const reqs = await fetchRequirements();
    const paid = await request(app)
      .post("/tick")
      .set("X-Drip-Session", "paid-dup")
      .set("PAYMENT-SIGNATURE", paymentHeader(reqs, AGENT));
    expect(paid.status).toBe(200);
    expect(fake.settleCount()).toBe(2);

    // then() sends the first one; the second arrives while it is still open
    const first = request(app).get("/stream").set("X-Drip-Session", "paid-dup");
    const firstDone = first.then((r) => r);
    const second = await request(app).get("/stream").set("X-Drip-Session", "paid-dup");
    expect(second.status).toBe(409);
    const firstRes = await firstDone;
    expect(firstRes.status).toBe(200);
  });

  it("watchdog cuts after payment stops: token/credit flow, and cut carries tickCount and spentAtomic", async () => {
    const reqs = await fetchRequirements();
    const paid = await request(app)
      .post("/tick")
      .set("X-Drip-Session", "paid-cut")
      .set("PAYMENT-SIGNATURE", paymentHeader(reqs, AGENT));
    expect(paid.status).toBe(200);
    expect(fake.settleCount()).toBe(3);

    const res = await request(app).get("/stream").set("X-Drip-Session", "paid-cut");
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
      spentAtomic: "40",
    });
  });

  it("paying again with a cut sessionId returns 409 and doesn't settle", async () => {
    const reqs = await fetchRequirements();
    const res = await request(app)
      .post("/tick")
      .set("X-Drip-Session", "paid-cut")
      .set("PAYMENT-SIGNATURE", paymentHeader(reqs, AGENT));
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/cut/);
    expect(fake.settleCount()).toBe(3);

    // After the cut the session has been removed from the ledger, so stream returns 404
    const stream = await request(app).get("/stream").set("X-Drip-Session", "paid-cut");
    expect(stream.status).toBe(404);
  });

  it("paying again mid-stream: credit immediately reflects the new tickCount (fresh store read)", async () => {
    const reqs = await fetchRequirements();
    const paid = await request(app)
      .post("/tick")
      .set("X-Drip-Session", "paid-ext")
      .set("PAYMENT-SIGNATURE", paymentHeader(reqs, AGENT));
    expect(paid.status).toBe(200);
    expect(fake.settleCount()).toBe(4);

    const stream = request(app).get("/stream").set("X-Drip-Session", "paid-ext");
    const streamDone = stream.then((r) => r);
    // let the first tick's stream get going first
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
    // After the extension credit must reflect tick #2 — if the handler captured store in a closure it would stay at 1 forever
    expect(credits.some((c) => c.tickCount === 2)).toBe(true);
    const cut = frames.filter((f) => f.event === "cut");
    expect(cut).toHaveLength(1);
    expect(JSON.parse(cut[0]!.data).tickCount).toBe(2);
  });

  it("agent disconnects itself: the session stays in the ledger and the watchdog sweeps it later", async () => {
    const reqs = await fetchRequirements();
    const paid = await request(app)
      .post("/tick")
      .set("X-Drip-Session", "paid-abort")
      .set("PAYMENT-SIGNATURE", paymentHeader(reqs, AGENT));
    expect(paid.status).toBe(200);

    const stream = request(app).get("/stream").set("X-Drip-Session", "paid-abort");
    const done = stream.then(
      () => null,
      () => null,
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    stream.abort();
    await done;

    // The agent disconnected itself, the server didn't cut it — the payment is still valid and the ledger entry remains
    const health = await request(app).get("/health");
    expect(health.body.sessions).toBe(1);
  });

  it("same sessionId with a different payer: settle succeeds but the session isn't extended (payer_mismatch)", async () => {
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

    // The hook refused to extend: tickCount is still 1, spentAtomic is still the first tick's 40
    const res = await request(app).get("/stream").set("X-Drip-Session", "paid-mismatch");
    expect(res.status).toBe(200);
    const frames = parseSse(res.text);
    const cut = frames.filter((f) => f.event === "cut");
    expect(cut).toHaveLength(1);
    expect(JSON.parse(cut[0]!.data)).toMatchObject({ tickCount: 1, spentAtomic: "40" });
  });
});
