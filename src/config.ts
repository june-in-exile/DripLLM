import { z } from "zod";

export class ConfigError extends Error {}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;
const ATOMIC = /^\d+$/;

const schema = z
  .object({
    SERVER_PORT: z.coerce.number().int().positive().default(4021),
    SERVER_BASE_URL: z.string().url().default("http://localhost:4021"),
    FACILITATOR_URL: z.string().url(),
    PAY_TO_ADDRESS: z.string().regex(ADDRESS, "須為 0x 開頭的 40 位十六進位地址"),
    AGENT_PRIVATE_KEY: z.string().regex(PRIVATE_KEY, "須為 0x 開頭的 64 位十六進位私鑰"),
    CREDIT_PER_TICK_MS: z.coerce.number().int().positive().default(5000),
    TOPUP_THRESHOLD_MS: z.coerce.number().int().positive().default(2000),
    GRACE_MS: z.coerce.number().int().positive().default(2000),
    PRICE_PER_TICK_ATOMIC: z.string().regex(ATOMIC).default("1000"),
    MAX_SPEND_ATOMIC: z.string().regex(ATOMIC).default("50000"),
    TOKEN_INTERVAL_MS: z.coerce.number().int().positive().default(120),
    CREDIT_EVENT_MS: z.coerce.number().int().positive().default(500),
    WATCHDOG_SWEEP_MS: z.coerce.number().int().positive().default(250),
    TOMBSTONE_TTL_MS: z.coerce.number().int().positive().default(60000),
  })
  .refine((c) => c.TOPUP_THRESHOLD_MS < c.CREDIT_PER_TICK_MS, {
    message: "TOPUP_THRESHOLD_MS 必須小於 CREDIT_PER_TICK_MS,否則補款永遠追不上消耗",
    path: ["TOPUP_THRESHOLD_MS"],
  });

export type AppConfig = Readonly<{
  serverPort: number;
  serverBaseUrl: string;
  facilitatorUrl: string;
  payToAddress: string;
  agentPrivateKey: string;
  creditPerTickMs: number;
  topupThresholdMs: number;
  graceMs: number;
  pricePerTickAtomic: bigint;
  maxSpendAtomic: bigint;
  tokenIntervalMs: number;
  creditEventMs: number;
  watchdogSweepMs: number;
  tombstoneTtlMs: number;
}>;

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new ConfigError(`環境變數設定有誤,請修正以下全部項目:\n${lines.join("\n")}`);
  }
  const v = parsed.data;
  return Object.freeze({
    serverPort: v.SERVER_PORT,
    serverBaseUrl: v.SERVER_BASE_URL,
    facilitatorUrl: v.FACILITATOR_URL,
    payToAddress: v.PAY_TO_ADDRESS,
    agentPrivateKey: v.AGENT_PRIVATE_KEY,
    creditPerTickMs: v.CREDIT_PER_TICK_MS,
    topupThresholdMs: v.TOPUP_THRESHOLD_MS,
    graceMs: v.GRACE_MS,
    pricePerTickAtomic: BigInt(v.PRICE_PER_TICK_ATOMIC),
    maxSpendAtomic: BigInt(v.MAX_SPEND_ATOMIC),
    tokenIntervalMs: v.TOKEN_INTERVAL_MS,
    creditEventMs: v.CREDIT_EVENT_MS,
    watchdogSweepMs: v.WATCHDOG_SWEEP_MS,
    tombstoneTtlMs: v.TOMBSTONE_TTL_MS,
  });
}
