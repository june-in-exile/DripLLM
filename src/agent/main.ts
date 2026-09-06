import { config as loadEnv } from "dotenv";
import { loadConfig, ConfigError, type AppConfig } from "../config.js";
import { createWallet } from "./wallet.js";
import { payTick, SessionCutError, type PayResult } from "./heartbeat.js";
import { createSseParser } from "./sse.js";
import { createLedger, canAfford, recordTick, type SpendLedger } from "./ledger.js";
import { renderTick, renderToken, renderCredit, renderStopPaying, renderCut } from "./render.js";
import { logger } from "../shared/logger.js";

loadEnv();

/** runAgent 的四個共享可變狀態。ledger 本身仍以不可變方式置換。 */
type AgentState = {
  paying: boolean;
  ledger: SpendLedger;
  sessionId: string;
  inFlight: boolean;
};

function createAgentState(config: AppConfig): AgentState {
  return {
    paying: true,
    ledger: createLedger(config.maxSpendAtomic, config.pricePerTickAtomic),
    sessionId: crypto.randomUUID(),
    inFlight: false,
  };
}

/**
 * 409 代表 sessionId 已被剪除,middleware 已取消結算(未扣款)。
 * 僅 tick #1 使用:此刻還沒有串流,換新 UUID 重試一次(spec §2.2.1)。
 */
async function payWithRetry(
  wallet: ReturnType<typeof createWallet>,
  config: AppConfig,
  state: AgentState,
): Promise<PayResult> {
  try {
    return await payTick(wallet, config, state.sessionId);
  } catch (e) {
    if (!(e instanceof SessionCutError)) throw e;
    state.sessionId = crypto.randomUUID();
    return await payTick(wallet, config, state.sessionId);
  }
}

/**
 * credit 事件驅動的補款。mid-stream 409 表示 session 已被剪除,
 * 此時重付只會為一個永遠沒有串流的 session 白付(phantom tick),
 * 直接停付、不重試不重付,等 server 剪線。
 */
async function topUp(
  wallet: ReturnType<typeof createWallet>,
  config: AppConfig,
  state: AgentState,
): Promise<void> {
  if (!state.paying || state.inFlight) return;
  if (!canAfford(state.ledger)) {
    state.paying = false;
    renderStopPaying("cap", state.ledger.spentAtomic);
    return;
  }
  state.inFlight = true;
  try {
    const r = await payTick(wallet, config, state.sessionId);
    state.ledger = recordTick(state.ledger);
    renderTick(state.ledger.tickCount, r.txHash, state.ledger.spentAtomic);
  } catch (e) {
    if (e instanceof SessionCutError) {
      state.paying = false;
      process.stdout.write("\n");
      logger.warn("agent", "session 已被剪除,停止付款");
    } else {
      logger.error("agent", `付款服務中斷,串流即將斷線:${String(e)}`);
      state.paying = false;
    }
  } finally {
    state.inFlight = false;
  }
}

/** settle 成功但 hook 拋錯時會出現這個 404。重試一次後放棄(spec §2.5 殘留風險)。 */
async function openStream(config: AppConfig, state: AgentState): Promise<Response> {
  const first = await fetch(`${config.serverBaseUrl}/stream`, {
    headers: { "X-Drip-Session": state.sessionId },
  });
  if (first.status !== 404) return first;
  await new Promise((r) => setTimeout(r, 300));
  return fetch(`${config.serverBaseUrl}/stream`, {
    headers: { "X-Drip-Session": state.sessionId },
  });
}

async function runStreamLoop(
  wallet: ReturnType<typeof createWallet>,
  config: AppConfig,
  state: AgentState,
): Promise<void> {
  const streamRes = await openStream(config, state);
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
        if (c.remainingMs < config.topupThresholdMs) void topUp(wallet, config, state);
      } else if (frame.event === "cut") {
        const c = JSON.parse(frame.data) as { tickCount: number; spentAtomic: string };
        renderCut(c.tickCount, BigInt(c.spentAtomic));
        process.exit(0);
      }
    }
  }
}

async function runAgent(config: AppConfig): Promise<void> {
  const wallet = createWallet(config);
  const state = createAgentState(config);

  // 第一次 Ctrl-C 只停付款,連線保持 —— 這是整個 demo 成立的關鍵。
  process.on("SIGINT", () => {
    if (state.paying) {
      state.paying = false;
      renderStopPaying("manual", state.ledger.spentAtomic);
      return;
    }
    process.exit(0);
  });

  // tick #1 不由 event: credit 驅動 —— 此刻 session 尚不存在(spec §2.2.1)
  const first = await payWithRetry(wallet, config, state);
  state.sessionId = first.sessionId;
  state.ledger = recordTick(state.ledger);
  renderTick(state.ledger.tickCount, first.txHash, state.ledger.spentAtomic);

  await runStreamLoop(wallet, config, state);
}

// loadConfig 必須在 async 鏈內,ConfigError 才會走下方友善訊息路徑。
async function main(): Promise<void> {
  await runAgent(loadConfig(process.env));
}

main().catch((e) => {
  if (e instanceof ConfigError) logger.error("agent", e.message);
  else logger.error("agent", String(e));
  process.exit(1);
});
