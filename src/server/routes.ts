import express, { type Express, type Request, type Response } from "express";
import type { AppConfig } from "../config.js";
import { createRegistry } from "./registry.js";
import { createStreamHub } from "./stream.js";
import { createWatchdog } from "./watchdog.js";
import { createSettleHook } from "./settleHook.js";
import { createPaymentStack } from "./payment.js";
import { createServerChannelStorage } from "./channelStorage.js";
import { startClaimJob } from "./claimJob.js";
import type { BatchSettlementChannelManager } from "@x402/evm/batch-settlement/server";
import { cannedTokenSource } from "./tokenSource.js";
import { remainingMs, inGrace } from "./sessions.js";
import { logger } from "../shared/logger.js";

export type BuiltApp = Readonly<{
  app: Express;
  /** Seller's claim scheduler. Normally driven by startClaimJob; manual smoke tests need to trigger it once on demand. */
  manager: BatchSettlementChannelManager;
  /** On shutdown, flush unclaimed vouchers so that revenue doesn't get stuck in storage (spec §9). */
  shutdown(): Promise<void>;
}>;

export async function buildApp(config: AppConfig): Promise<BuiltApp> {
  const registry = createRegistry();
  const hub = createStreamHub();
  const watchdog = createWatchdog({
    registry,
    hub,
    graceMs: config.graceMs,
    tombstoneTtlMs: config.tombstoneTtlMs,
  });
  const tokens = cannedTokenSource();

  const hook = createSettleHook({
    registry,
    creditMs: config.creditPerTickMs,
    priceAtomic: config.pricePerTickAtomic,
    depositTopupAtomic: config.depositTopupAtomic,
  });
  const storage = createServerChannelStorage(config.channelStorageDir);
  const payment = createPaymentStack(config, storage, hook as never);
  const claimJob = startClaimJob(payment.manager, config);

  const app = express();
  app.use(express.json());
  app.use(payment.middleware);

  app.get("/health", (_req, res) => {
    res.json({ ok: true, sessions: registry.getStore().size });
  });

  app.post("/tick", (req: Request, res: Response) => {
    const sessionId = req.header("X-Drip-Session");
    if (!sessionId) {
      res.status(400).json({ error: "missing X-Drip-Session header" });
      return;
    }

    // The tombstone check must live here, not in the hook.
    // Middleware order is verify → handler → settle, and statusCode >= 400 triggers
    // cancellationDispatcher.cancel(), so when we return 409 here the payment hasn't gone on-chain and the agent isn't charged.
    // If this moved into the hook, the new id couldn't be sent — the body is finalized at res.end() (spec §2.2.1).
    if (registry.isCut(sessionId, Date.now(), config.tombstoneTtlMs)) {
      res.status(409).json({ error: "this sessionId has been cut, use a new sessionId" });
      return;
    }

    res.json({ sessionId, accepted: true });
  });

  app.get("/stream", (req: Request, res: Response) => {
    // sessionId is treated as a bearer token (spec §2.2) and carried in a header —
    // putting it in the query string would leak it into proxy/access logs and invite hijacking.
    const sessionId = req.header("X-Drip-Session");
    if (!sessionId) {
      res.status(400).json({ error: "missing X-Drip-Session header" });
      return;
    }
    const session = registry.getStore().get(sessionId);
    if (!session) {
      res.status(404).json({ error: "session not found or expired, pay first" });
      return;
    }
    if (!hub.attach(sessionId, res)) {
      res.status(409).json({ error: "this session already has a stream connection" });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.flushHeaders();

    // The iterator is created only once — rebuilding it every tick would stay stuck on the first token forever.
    const iter = tokens.open()[Symbol.asyncIterator]();
    const tokenTimer = setInterval(() => {
      void iter.next().then((next) => {
        if (!next.done) hub.sendToken(sessionId, next.value);
      });
    }, config.tokenIntervalMs);

    const creditTimer = setInterval(() => {
      const current = registry.getStore().get(sessionId);
      if (!current) return;
      const now = Date.now();
      hub.sendCredit(sessionId, {
        remainingMs: remainingMs(current, now),
        grace: inGrace(current, now, config.graceMs),
        tickCount: current.tickCount,
        spentAtomic: current.spentAtomic.toString(),
      });
    }, config.creditEventMs);

    res.on("close", () => {
      clearInterval(tokenTimer);
      clearInterval(creditTimer);
      // Read the store fresh, never capture it (spec §6.3.1).
      // Still in the ledger = the agent disconnected itself; gone = the watchdog cut it.
      const cutByServer = !registry.getStore().has(sessionId);
      logger.info("stream", cutByServer ? `session ${sessionId.slice(0, 4)} was cut by the server` : `session ${sessionId.slice(0, 4)} was disconnected by the agent`);
      hub.detach(sessionId);
    });
  });

  watchdog.start(config.watchdogSweepMs);

  return {
    app,
    manager: payment.manager,
    async shutdown() {
      watchdog.stop();
      await claimJob.stop({ flush: true });
    },
  };
}
