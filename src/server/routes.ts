import express, { type Express, type Request, type Response } from "express";
import type { AppConfig } from "../config.js";
import { createRegistry } from "./registry.js";
import { createStreamHub } from "./stream.js";
import { createWatchdog } from "./watchdog.js";
import { createSettleHook } from "./settleHook.js";
import { createPaymentMiddleware } from "./payment.js";
import { cannedTokenSource } from "./tokenSource.js";
import { remainingMs, inGrace } from "./sessions.js";
import { logger } from "../shared/logger.js";

export async function buildApp(config: AppConfig): Promise<Express> {
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
  });

  const app = express();
  app.use(express.json());
  app.use(createPaymentMiddleware(config, hook as never));

  app.get("/health", (_req, res) => {
    res.json({ ok: true, sessions: registry.getStore().size });
  });

  app.post("/tick", (req: Request, res: Response) => {
    const sessionId = req.header("X-Drip-Session");
    if (!sessionId) {
      res.status(400).json({ error: "缺少 X-Drip-Session header" });
      return;
    }

    // tombstone 檢查必須在這裡,不能放進 hook。
    // middleware 順序是 verify → handler → settle,且 statusCode >= 400 會觸發
    // cancellationDispatcher.cancel(),因此在此回 409 時付款尚未上鏈,agent 不會被扣款。
    // 若改到 hook 處理,新 id 送不出去 —— body 在 res.end() 時已定案(spec §2.2.1)。
    if (registry.isCut(sessionId, Date.now(), config.tombstoneTtlMs)) {
      res.status(409).json({ error: "此 sessionId 已被剪除,請改用新的 sessionId" });
      return;
    }

    res.json({ sessionId, accepted: true });
  });

  app.get("/stream", (req: Request, res: Response) => {
    // sessionId 視為 bearer token(spec §2.2),經 header 傳輸 ——
    // 放 query string 會漏進 proxy/access logs,助長劫持。
    const sessionId = req.header("X-Drip-Session");
    if (!sessionId) {
      res.status(400).json({ error: "缺少 X-Drip-Session header" });
      return;
    }
    const session = registry.getStore().get(sessionId);
    if (!session) {
      res.status(404).json({ error: "session 不存在或已過期,請先付款" });
      return;
    }
    if (!hub.attach(sessionId, res)) {
      res.status(409).json({ error: "此 session 已有一條串流連線" });
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.flushHeaders();

    // 迭代器只建立一次 —— 每次 tick 重建會永遠停在第一個詞元。
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
      // 現讀 store,不可捕獲(spec §6.3.1)。
      // 仍在帳本中 = agent 自己斷的;已不在 = watchdog 剪的。
      const cutByServer = !registry.getStore().has(sessionId);
      logger.info("stream", cutByServer ? `session ${sessionId.slice(0, 4)} 已由 server 剪線` : `session ${sessionId.slice(0, 4)} 由 agent 主動斷線`);
      hub.detach(sessionId);
    });
  });

  watchdog.start(config.watchdogSweepMs);
  return app;
}
