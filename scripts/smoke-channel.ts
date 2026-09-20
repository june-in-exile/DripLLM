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
 * spec §8 第 3 層的鏈上冒煙測試:deposit → 10 格 voucher → claim → refund。
 * 手動執行,不進 CI。只需要 facilitator 先起來(npm run facilitator);
 * server 由本腳本在行程內啟動,才能在正確時點手動觸發 claim。
 *
 * ⚠ 會送出真實的 Fuji 交易並消耗測試網 USDC 與 AVAX。
 */
type Stage = Readonly<{ label: string; tx: string; ms: number }>;

const publicClient = (config: AppConfig) =>
  createPublicClient({ chain: avalancheFuji, transport: http(config.fujiRpcUrl) });

async function reportGas(config: AppConfig, stages: Stage[]): Promise<void> {
  const client = publicClient(config);
  logger.info("smoke", "—— 各階段 tx 與 gas ——");
  for (const stage of stages) {
    try {
      const receipt = await client.getTransactionReceipt({ hash: stage.tx as `0x${string}` });
      const fee = receipt.gasUsed * receipt.effectiveGasPrice;
      logger.info(
        "smoke",
        `${stage.label} · ${stage.ms}ms · gas ${receipt.gasUsed} · ${fee} wei · ${stage.tx}`,
      );
    } catch (e) {
      logger.warn("smoke", `${stage.label} · ${stage.ms}ms · 無法取得 receipt:${String(e)}`);
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
    logger.info("smoke", `voucher ${i}/${VOUCHER_TICKS} · ${ms}ms · 上限 ${r.signedCeiling}`);
  }
  return durations;
}

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  logger.warn("smoke", "本腳本會送出真實 Fuji 交易並消耗測試網 USDC");

  const { app, manager, shutdown } = await buildApp(config);
  const server = app.listen(config.serverPort);
  const stages: Stage[] = [];

  try {
    const depositStart = Date.now();
    const wallet = createWallet(config);
    const deposit = await payTick(wallet, config, crypto.randomUUID());
    const depositMs = Date.now() - depositStart;
    if (!deposit.txHash) throw new Error("第一格沒有 deposit 交易,channel 可能已存在且餘額足夠");
    stages.push({ label: "deposit", tx: deposit.txHash, ms: depositMs });
    logger.info("smoke", `deposit · ${depositMs}ms · tx ${deposit.txHash}`);

    const voucherMs = await runVoucherTicks(wallet, config);

    const claimStart = Date.now();
    const claims = await manager.claim({ maxClaimsPerBatch: config.maxClaimsPerBatch });
    const claimMs = Date.now() - claimStart;
    for (const claim of claims) {
      stages.push({ label: `claim(${claim.vouchers} voucher)`, tx: claim.transaction, ms: claimMs });
    }
    if (claims.length === 0) logger.warn("smoke", "沒有可請款的 voucher");

    // 用買方端的 cooperative refund(§10.7 的路徑)。賣方端的 manager.refund()
    // 不會通知買方,client 的本地 channel 紀錄會就地失效。
    const refundStart = Date.now();
    await wallet.refund();
    const refundMs = Date.now() - refundStart;
    logger.info("smoke", `refund · ${refundMs}ms`);

    await reportGas(config, stages);
    logger.info("smoke", `refund(買方端)· ${refundMs}ms`);
    logger.info("smoke", "—— spec §8 第 0 步的量測值 ——");
    logger.info("smoke", `1. deposit 上鏈 wall-clock:${depositMs}ms`);
    logger.info(
      "smoke",
      `2. 單格 voucher /tick wall-clock:最小 ${Math.min(...voucherMs)}ms · 最大 ${Math.max(...voucherMs)}ms`,
    );
    logger.info("smoke", `3. claim 上鏈 wall-clock:${claimMs}ms(gas 見上表)`);
    logger.info(
      "smoke",
      `4. viem 對 Fuji 的預設 pollingInterval 為 2000ms,本次設為 ${config.facilitatorPollingMs}ms`,
    );
  } finally {
    server.close();
    await shutdown().catch((e) => logger.error("smoke", `關閉失敗:${String(e)}`));
  }
}

main().catch((e) => {
  logger.error("smoke", String(e));
  process.exit(1);
});
