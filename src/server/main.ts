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
    logger.error("server", `facilitator 無回應 (${url}) —— 先跑 npm run facilitator`);
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
    logger.info("server", `聽在 http://localhost:${cfg.serverPort}`);
  });

  // 關站前把尚未 claim 的 voucher 沖出去 —— 那些簽章只存在賣方手上(spec §2.5.3)。
  let closing = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (closing) return;
      closing = true;
      logger.info("server", "收到關站訊號,結算未請款的 voucher…");
      server.close();
      shutdown()
        .catch((e) => logger.error("server", `關站結算失敗:${String(e)}`))
        .finally(() => process.exit(0));
    });
  }
}

main().catch((e) => {
  logger.error("server", String(e));
  process.exit(1);
});
