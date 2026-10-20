import { config as loadEnv } from "dotenv";
import { loadConfig, ConfigError, type AppConfig } from "../config.js";
import { createWallet } from "./wallet.js";
import { payTick, SessionCutError, type PayResult } from "./heartbeat.js";
import { createSseParser } from "./sse.js";
import { createLedger, canAfford, recordTick, type SpendLedger } from "./ledger.js";
import { renderTick, renderToken, renderCredit, renderStopPaying, renderCut } from "./render.js";
import { isNothingToRefund } from "./refund.js";
import { logger } from "../shared/logger.js";

loadEnv();

/** The four pieces of shared mutable state in runAgent. The ledger itself is still swapped immutably. */
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
 * 409 means the sessionId has been cut and the middleware cancelled settlement (nothing charged).
 * Used only for tick #1: there is no stream yet, so retry once with a new UUID (spec §2.2.1).
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
 * Top-up driven by credit events. A mid-stream 409 means the session has been cut;
 * paying again would only waste money on a session that will never stream (a phantom tick),
 * so stop paying outright -- no retry, no repay -- and wait for the server to cut.
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
    renderTick(state.ledger.tickCount, r.txHash, state.ledger.spentAtomic, {
      balance: r.channelBalance,
      ceiling: r.signedCeiling,
      cumulative: r.chargedCumulative,
    });
  } catch (e) {
    if (e instanceof SessionCutError) {
      state.paying = false;
      process.stdout.write("\n");
      logger.warn("agent", "session was cut, stopped paying");
    } else {
      logger.error("agent", `payment service down, stream about to drop: ${String(e)}`);
      state.paying = false;
    }
  } finally {
    state.inFlight = false;
  }
}

/** A failed refund must not be silent -- the deposit stays in the contract and the user must know to reclaim it manually (spec §10.7). */
async function refundQuietly(wallet: ReturnType<typeof createWallet>): Promise<void> {
  try {
    await wallet.refund();
  } catch (e) {
    if (isNothingToRefund(e)) {
      logger.info("agent", "deposit fully used, nothing to refund");
      return;
    }
    logger.error("agent", `deposit refund failed, deposit still locked in the channel: ${String(e)}`);
  }
}

/** This 404 appears when settle succeeds but the hook throws. Retry once, then give up (spec §2.5 residual risk). */
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
    logger.error("agent", "session creation failed; that payment settled but never took effect");
    process.exit(1);
  }
  if (!streamRes.body) throw new Error("Stream response has no body");

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
        await refundQuietly(wallet);
        process.exit(0);
      }
    }
  }
}

async function runAgent(config: AppConfig): Promise<void> {
  const wallet = createWallet(config);
  const state = createAgentState(config);

  // The first Ctrl-C only stops paying and keeps the connection open -- the whole demo hinges on this.
  let interruptCount = 0;
  process.on("SIGINT", () => {
    interruptCount++;
    if (state.paying && interruptCount === 1) {
      state.paying = false;
      renderStopPaying("manual", state.ledger.spentAtomic);
      return;
    }
    void refundQuietly(wallet).finally(() => process.exit(0));
  });

  // tick #1 is not driven by event: credit -- the session doesn't exist yet (spec §2.2.1)
  const first = await payWithRetry(wallet, config, state);
  state.sessionId = first.sessionId;
  state.ledger = recordTick(state.ledger);
  renderTick(state.ledger.tickCount, first.txHash, state.ledger.spentAtomic, {
    balance: first.channelBalance,
    ceiling: first.signedCeiling,
    cumulative: first.chargedCumulative,
  });

  await runStreamLoop(wallet, config, state);
}

// loadConfig must run inside the async chain so ConfigError takes the friendly-message path below.
async function main(): Promise<void> {
  await runAgent(loadConfig(process.env));
}

main().catch((e) => {
  if (e instanceof ConfigError) logger.error("agent", e.message);
  else logger.error("agent", String(e));
  process.exit(1);
});
