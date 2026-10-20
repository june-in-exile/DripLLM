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
    // Each tick uses a fresh sessionId: smoke opens no stream and does no top-up, so reusing an id would get it
    // cut by the watchdog during settle (8-10s measured) and hit a tombstone 409.
    const t = Date.now();
    const r = await payTick(wallet, config, crypto.randomUUID());
    logger.info("smoke", `tick ${i} · ${Date.now() - t}ms · tx ${r.txHash}`);
  }
}

main().catch((e) => {
  logger.error("smoke", String(e));
  process.exit(1);
});
