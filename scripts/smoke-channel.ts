import { config as loadEnv } from "dotenv";
import { createPublicClient, http } from "viem";
import { avalancheFuji } from "viem/chains";
import { loadConfig, type AppConfig } from "../src/config.js";
import { buildApp } from "../src/server/routes.js";
import { createWallet } from "../src/agent/wallet.js";
import { payTick } from "../src/agent/heartbeat.js";
import { logger } from "../src/shared/logger.js";

loadEnv();

const VOUCHER_TICKS = 10;

/**
 * On-chain smoke test for layer 3 of spec §8: deposit → 10 voucher ticks → claim → refund.
 * Run manually, not in CI. Only needs the facilitator up first (npm run facilitator);
 * this script starts the server in-process so it can trigger the claim manually at the right moment.
 *
 * ⚠ Sends real Fuji transactions and spends testnet USDC and AVAX.
 */
type Stage = Readonly<{ label: string; tx: string; ms: number }>;

const publicClient = (config: AppConfig) =>
  createPublicClient({ chain: avalancheFuji, transport: http(config.fujiRpcUrl) });

async function reportGas(config: AppConfig, stages: Stage[]): Promise<void> {
  const client = publicClient(config);
  logger.info("smoke", "-- tx and gas per stage --");
  for (const stage of stages) {
    try {
      const receipt = await client.getTransactionReceipt({ hash: stage.tx as `0x${string}` });
      const fee = receipt.gasUsed * receipt.effectiveGasPrice;
      logger.info(
        "smoke",
        `${stage.label} · ${stage.ms}ms · gas ${receipt.gasUsed} · ${fee} wei · ${stage.tx}`,
      );
    } catch (e) {
      logger.warn("smoke", `${stage.label} · ${stage.ms}ms · could not fetch receipt: ${String(e)}`);
    }
  }
}

async function runVoucherTicks(
  wallet: ReturnType<typeof createWallet>,
  config: AppConfig,
): Promise<number[]> {
  const durations: number[] = [];
  for (let i = 1; i <= VOUCHER_TICKS; i++) {
    const started = Date.now();
    const r = await payTick(wallet, config, crypto.randomUUID());
    const ms = Date.now() - started;
    durations.push(ms);
    logger.info("smoke", `voucher ${i}/${VOUCHER_TICKS} · ${ms}ms · cap ${r.signedCeiling}`);
  }
  return durations;
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  logger.warn("smoke", "this script sends real Fuji transactions and spends testnet USDC");

  const { app, manager, shutdown } = await buildApp(config);
  const server = app.listen(config.serverPort);
  const stages: Stage[] = [];

  try {
    const depositStart = Date.now();
    const wallet = createWallet(config);
    const deposit = await payTick(wallet, config, crypto.randomUUID());
    const depositMs = Date.now() - depositStart;
    if (!deposit.txHash) throw new Error("First tick had no deposit transaction; the channel may already exist with enough balance");
    stages.push({ label: "deposit", tx: deposit.txHash, ms: depositMs });
    logger.info("smoke", `deposit · ${depositMs}ms · tx ${deposit.txHash}`);

    const voucherMs = await runVoucherTicks(wallet, config);

    const claimStart = Date.now();
    const claims = await manager.claim({ maxClaimsPerBatch: config.maxClaimsPerBatch });
    const claimMs = Date.now() - claimStart;
    for (const claim of claims) {
      stages.push({ label: `claim(${claim.vouchers} voucher)`, tx: claim.transaction, ms: claimMs });
    }
    if (claims.length === 0) logger.warn("smoke", "no vouchers to claim");

    // Use the buyer-side cooperative refund (the §10.7 path). The seller-side manager.refund()
    // doesn't notify the buyer, which would silently invalidate the client's local channel record.
    const refundStart = Date.now();
    await wallet.refund();
    const refundMs = Date.now() - refundStart;
    logger.info("smoke", `refund · ${refundMs}ms`);

    await reportGas(config, stages);
    logger.info("smoke", `refund (buyer side) · ${refundMs}ms`);
    logger.info("smoke", "-- spec §8 step 0 measurements --");
    logger.info("smoke", `1. deposit on-chain wall-clock: ${depositMs}ms`);
    logger.info(
      "smoke",
      `2. single voucher /tick wall-clock: min ${Math.min(...voucherMs)}ms · max ${Math.max(...voucherMs)}ms`,
    );
    logger.info("smoke", `3. claim on-chain wall-clock: ${claimMs}ms (gas in table above)`);
    logger.info(
      "smoke",
      `4. viem's default pollingInterval for Fuji is 2000ms; this run uses ${config.facilitatorPollingMs}ms`,
    );
  } finally {
    server.close();
    await shutdown().catch((e) => logger.error("smoke", `shutdown failed: ${String(e)}`));
  }
}

main().catch((e) => {
  logger.error("smoke", String(e));
  process.exit(1);
});
