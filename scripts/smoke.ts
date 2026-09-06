import { config as loadEnv } from "dotenv";
import { loadConfig } from "../src/config.js";
import { createWallet } from "../src/agent/wallet.js";
import { payTick } from "../src/agent/heartbeat.js";
import { logger } from "../src/shared/logger.js";

loadEnv();

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const wallet = createWallet(config);
  for (let i = 1; i <= 3; i++) {
    // 每個 tick 用全新 sessionId:smoke 不開串流也不補款,沿用舊 id 會在
    // settle(實測 8-10s)期間被 watchdog 剪除而撞上 tombstone 409。
    const t = Date.now();
    const r = await payTick(wallet, config, crypto.randomUUID());
    logger.info("smoke", `tick ${i} · ${Date.now() - t}ms · tx ${r.txHash}`);
  }
}

main().catch((e) => {
  logger.error("smoke", String(e));
  process.exit(1);
});
