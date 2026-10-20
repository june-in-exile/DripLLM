import { config as loadEnv } from "dotenv";
import { ConfigError, loadConfig } from "../config.js";
import { logger } from "../shared/logger.js";
import { buildFacilitator } from "./facilitator.js";
import { createFacilitatorApp } from "./app.js";

loadEnv();

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const app = createFacilitatorApp(buildFacilitator(config));
  app.listen(config.facilitatorPort, () => {
    logger.info("facilitator", `listening on http://localhost:${config.facilitatorPort}`);
  });
}

main().catch((error) => {
  if (error instanceof ConfigError) logger.error("facilitator", error.message);
  else logger.error("facilitator", String(error));
  process.exit(1);
});
