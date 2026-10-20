import { z } from "zod";

export class ConfigError extends Error {}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;
const ATOMIC = /^\d+$/;

const schema = z
  .object({
    SERVER_PORT: z.coerce.number().int().positive().default(4021),
    FACILITATOR_PORT: z.coerce.number().int().positive().default(8080),
    SERVER_BASE_URL: z.string().url().default("http://localhost:4021"),
    FACILITATOR_URL: z.string().url(),
    FACILITATOR_PRIVATE_KEY: z.string().regex(PRIVATE_KEY, "must be a 0x-prefixed 64-digit hex private key"),
    FUJI_RPC_URL: z.string().url().default("https://api.avax-test.network/ext/bc/C/rpc"),
    LLM_PROVIDER_ADDRESS: z.string().regex(ADDRESS, "must be a 0x-prefixed 40-digit hex address"),
    // Optional. If set, the seller signs claim/refund authorizations itself (the receiverAuthorizer in spec §2.4);
    // if empty, this is delegated to the facilitator, which advertises a receiverAuthorizer on /supported.
    LLM_PROVIDER_AUTHORIZER_PRIVATE_KEY: z
      .string()
      .regex(PRIVATE_KEY, "must be a 0x-prefixed 64-digit hex private key")
      .optional(),
    AGENT_PRIVATE_KEY: z.string().regex(PRIVATE_KEY, "must be a 0x-prefixed 64-digit hex private key"),
    CREDIT_PER_TICK_MS: z.coerce.number().int().positive().default(1000),
    TOPUP_THRESHOLD_MS: z.coerce.number().int().positive().default(300),
    GRACE_MS: z.coerce.number().int().positive().default(250),
    PRICE_PER_TICK_ATOMIC: z.string().regex(ATOMIC).default("40"),
    MAX_SPEND_ATOMIC: z.string().regex(ATOMIC).default("50000"),
    TOKEN_INTERVAL_MS: z.coerce.number().int().positive().default(120),
    CREDIT_EVENT_MS: z.coerce.number().int().positive().default(250),
    WATCHDOG_SWEEP_MS: z.coerce.number().int().positive().default(100),
    TOMBSTONE_TTL_MS: z.coerce.number().int().positive().default(60000),
    DEPOSIT_ATOMIC: z.string().regex(ATOMIC).default("50000"),
    DEPOSIT_TOPUP_ATOMIC: z.string().regex(ATOMIC).default("5000"),
    WITHDRAW_DELAY_SECS: z.coerce.number().int().positive().default(900),
    CLAIM_INTERVAL_SECS: z.coerce.number().int().positive().default(60),
    SETTLE_INTERVAL_SECS: z.coerce.number().int().positive().default(300),
    REFUND_IDLE_SECS: z.coerce.number().int().positive().default(120),
    MAX_CLAIMS_PER_BATCH: z.coerce.number().int().positive().default(20),
    // Poll interval for front-running withdrawals. Each poll scans the whole channel storage, so don't make it as tight as the watchdog;
    // as long as it is far below WITHDRAW_DELAY_SECS there is plenty of room to claim (spec §2.5.2).
    WITHDRAW_POLL_MS: z.coerce.number().int().positive().default(5_000),
    CHANNEL_STORAGE_DIR: z.string().min(1).default(".dripllm/channels"),
    FACILITATOR_POLLING_MS: z.coerce.number().int().positive().default(250),
    FACILITATOR_CONFIRMATION_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  })
  .refine((c) => c.TOPUP_THRESHOLD_MS < c.CREDIT_PER_TICK_MS, {
    message: "TOPUP_THRESHOLD_MS must be less than CREDIT_PER_TICK_MS, otherwise top-ups can never keep up with consumption",
    path: ["TOPUP_THRESHOLD_MS"],
  })
  .refine((c) => c.WITHDRAW_DELAY_SECS > c.CLAIM_INTERVAL_SECS, {
    message: "WITHDRAW_DELAY_SECS must be greater than CLAIM_INTERVAL_SECS",
    path: ["WITHDRAW_DELAY_SECS"],
  })
  .refine((c) => c.WITHDRAW_POLL_MS < c.WITHDRAW_DELAY_SECS * 1_000, {
    message: "WITHDRAW_POLL_MS must be less than WITHDRAW_DELAY_SECS, otherwise a withdrawal can never be front-run in time",
    path: ["WITHDRAW_POLL_MS"],
  });

export type AppConfig = Readonly<{
  serverPort: number;
  facilitatorPort: number;
  serverBaseUrl: string;
  facilitatorUrl: string;
  facilitatorPrivateKey: string;
  fujiRpcUrl: string;
  llmProviderAddress: string;
  llmProviderAuthorizerPrivateKey: string | undefined;
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
  depositAtomic: bigint;
  depositTopupAtomic: bigint;
  withdrawDelaySecs: number;
  claimIntervalSecs: number;
  settleIntervalSecs: number;
  refundIdleSecs: number;
  maxClaimsPerBatch: number;
  withdrawPollMs: number;
  channelStorageDir: string;
  facilitatorPollingMs: number;
  facilitatorConfirmationTimeoutMs: number;
}>;

export function loadConfig(env: NodeJS.ProcessEnv): AppConfig {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`);
    throw new ConfigError(`Invalid environment variables; fix all of the following:\n${lines.join("\n")}`);
  }
  const v = parsed.data;
  return Object.freeze({
    serverPort: v.SERVER_PORT,
    facilitatorPort: v.FACILITATOR_PORT,
    serverBaseUrl: v.SERVER_BASE_URL,
    facilitatorUrl: v.FACILITATOR_URL,
    facilitatorPrivateKey: v.FACILITATOR_PRIVATE_KEY,
    fujiRpcUrl: v.FUJI_RPC_URL,
    llmProviderAddress: v.LLM_PROVIDER_ADDRESS,
    llmProviderAuthorizerPrivateKey: v.LLM_PROVIDER_AUTHORIZER_PRIVATE_KEY,
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
    depositAtomic: BigInt(v.DEPOSIT_ATOMIC),
    depositTopupAtomic: BigInt(v.DEPOSIT_TOPUP_ATOMIC),
    withdrawDelaySecs: v.WITHDRAW_DELAY_SECS,
    claimIntervalSecs: v.CLAIM_INTERVAL_SECS,
    settleIntervalSecs: v.SETTLE_INTERVAL_SECS,
    refundIdleSecs: v.REFUND_IDLE_SECS,
    maxClaimsPerBatch: v.MAX_CLAIMS_PER_BATCH,
    withdrawPollMs: v.WITHDRAW_POLL_MS,
    channelStorageDir: v.CHANNEL_STORAGE_DIR,
    facilitatorPollingMs: v.FACILITATOR_POLLING_MS,
    facilitatorConfirmationTimeoutMs: v.FACILITATOR_CONFIRMATION_TIMEOUT_MS,
  });
}
