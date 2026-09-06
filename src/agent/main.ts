import { config as loadEnv } from "dotenv";
import { loadConfig, ConfigError } from "../config.js";
import { createWallet } from "./wallet.js";
import { payTick, SessionCutError } from "./heartbeat.js";
import { createSseParser } from "./sse.js";
import { createLedger, canAfford, recordTick, type SpendLedger } from "./ledger.js";
import { renderTick, renderToken, renderCredit, renderStopPaying, renderCut } from "./render.js";
import { logger } from "../shared/logger.js";

loadEnv();

async function runAgent(): Promise<void> {
  const config = loadConfig(process.env);
  const wallet = createWallet(config);

  let paying = true;
  let ledger: SpendLedger = createLedger(config.maxSpendAtomic, config.pricePerTickAtomic);
  let sessionId: string = crypto.randomUUID();
  let inFlight = false;

  // 第一次 Ctrl-C 只停付款,連線保持 —— 這是整個 demo 成立的關鍵。
  process.on("SIGINT", () => {
    if (paying) {
      paying = false;
      renderStopPaying("manual", ledger.spentAtomic);
      return;
    }
    process.exit(0);
  });

  // 409 代表 sessionId 已被剪除,middleware 已取消結算(未扣款)。換新 UUID 重試一次。
  const payWithRetry = async (): Promise<{ sessionId: string; txHash: string }> => {
    try {
      return await payTick(wallet, config, sessionId);
    } catch (e) {
      if (!(e instanceof SessionCutError)) throw e;
      sessionId = crypto.randomUUID();
      return await payTick(wallet, config, sessionId);
    }
  };

  // tick #1 不由 event: credit 驅動 —— 此刻 session 尚不存在(spec §2.2.1)
  const first = await payWithRetry();
  sessionId = first.sessionId;
  ledger = recordTick(ledger);
  renderTick(ledger.tickCount, first.txHash, ledger.spentAtomic);

  const topUp = async (): Promise<void> => {
    if (!paying || inFlight) return;
    if (!canAfford(ledger)) {
      paying = false;
      renderStopPaying("cap", ledger.spentAtomic);
      return;
    }
    inFlight = true;
    try {
      const r = await payWithRetry();
      ledger = recordTick(ledger);
      renderTick(ledger.tickCount, r.txHash, ledger.spentAtomic);
    } catch (e) {
      logger.error("agent", `付款服務中斷,串流即將斷線:${String(e)}`);
      paying = false;
    } finally {
      inFlight = false;
    }
  };

  // settle 成功但 hook 拋錯時會出現這個 404。重試一次後放棄(spec §2.5 殘留風險)。
  const openStream = async (): Promise<Response> => {
    const first = await fetch(`${config.serverBaseUrl}/stream`, {
      headers: { "X-Drip-Session": sessionId },
    });
    if (first.status !== 404) return first;
    await new Promise((r) => setTimeout(r, 300));
    return fetch(`${config.serverBaseUrl}/stream`, {
      headers: { "X-Drip-Session": sessionId },
    });
  };

  const streamRes = await openStream();
  if (streamRes.status === 404) {
    logger.error("agent", "session 建立失敗,該筆付款已結算但未生效");
    process.exit(1);
  }
  if (!streamRes.body) throw new Error("串流無回應主體");

  const parse = createSseParser();
  const reader = streamRes.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const frame of parse(decoder.decode(value, { stream: true }))) {
      if (frame.event === "token") {
        renderToken(frame.data);
      } else if (frame.event === "credit") {
        const c = JSON.parse(frame.data) as { remainingMs: number; grace: boolean };
        renderCredit(c.remainingMs, c.grace);
        if (c.remainingMs < config.topupThresholdMs) void topUp();
      } else if (frame.event === "cut") {
        const c = JSON.parse(frame.data) as { tickCount: number; spentAtomic: string };
        renderCut(c.tickCount, BigInt(c.spentAtomic));
        process.exit(0);
      }
    }
  }
}

runAgent().catch((e) => {
  if (e instanceof ConfigError) logger.error("agent", e.message);
  else logger.error("agent", String(e));
  process.exit(1);
});
