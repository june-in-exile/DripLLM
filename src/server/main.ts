import { config as loadEnv } from "dotenv";
import { loadConfig, ConfigError } from "../config.js";
import type { AppConfig } from "../config.js";
import { buildApp } from "./routes.js";
import { logger } from "../shared/logger.js";

loadEnv();

async function assertFacilitatorUp(url: string): Promise<void> {
  try {
    const res = await fetch(`${url}/health`);
    if (!res.ok) throw new Error(String(res.status));
  } catch {
    logger.error("server", `facilitator not responding (${url}) — run npm run facilitator first`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  let cfg: AppConfig;
  try {
    cfg = loadConfig(process.env);
  } catch (e) {
    if (e instanceof ConfigError) {
      logger.error("server", e.message);
      process.exit(1);
    }
    throw e;
  }

  await assertFacilitatorUp(cfg.facilitatorUrl);
  const { app, shutdown } = await buildApp(cfg);
  const server = app.listen(cfg.serverPort, () => {
    logger.info("server", `listening on http://localhost:${cfg.serverPort}`);
  });

  // Before shutdown, flush unclaimed vouchers — those signatures exist only in the seller's hands (spec §2.5.3).
  let closing = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (closing) return;
      closing = true;
      logger.info("server", "shutdown signal received, settling unclaimed vouchers…");
      server.close();
      shutdown()
        .catch((e) => logger.error("server", `shutdown settlement failed: ${String(e)}`))
        .finally(() => process.exit(0));
    });
  }
}

main().catch((e) => {
  logger.error("server", String(e));
  process.exit(1);
});
