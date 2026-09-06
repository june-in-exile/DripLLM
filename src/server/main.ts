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
    logger.error("server", `facilitator 無回應 (${url}) —— 先跑 docker compose up`);
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
  const app = await buildApp(cfg);
  app.listen(cfg.serverPort, () => {
    logger.info("server", `聽在 http://localhost:${cfg.serverPort}`);
  });
}

main().catch((e) => {
  logger.error("server", String(e));
  process.exit(1);
});
