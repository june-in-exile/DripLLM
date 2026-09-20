import { x402Client, wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import {
  BatchSettlementEvmScheme,
  type BatchSettlementDepositStrategy,
  buildChannelConfig,
  computeChannelId,
  refundChannel,
} from "@x402/evm/batch-settlement/client";
import { FileClientChannelStorage } from "@x402/evm/batch-settlement/client/file-storage";
import { toClientEvmSigner } from "@x402/evm";
import { createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { avalancheFuji } from "viem/chains";
import { FUJI_USDC } from "../shared/usdc.js";
import type { AppConfig } from "../config.js";

/**
 * 開場存 DEPOSIT_ATOMIC,串流中不夠就補 DEPOSIT_TOPUP_ATOMIC(spec §5.2)。
 *
 * 「是不是開場」不可以用 `currentBalance === 0` 判斷 —— 退款只退回未消耗的部分,
 * 已消耗未請款的金額會留在 channel 裡,於是重用的 channel 永遠走補款分支,
 * DEPOSIT_ATOMIC 再也不會生效。改以「餘額連一次補款都不到」為開場的判準。
 */
function configuredDepositStrategy(config: AppConfig): BatchSettlementDepositStrategy {
  return ({ currentBalance, minimumDepositAmount }) => {
    const minimum = BigInt(minimumDepositAmount);
    const opening = BigInt(currentBalance) < config.depositTopupAtomic;
    const target = opening ? config.depositAtomic : config.depositTopupAtomic;
    return (target > minimum ? target : minimum).toString();
  };
}

/** 套件的 DEFAULT_SALT。我們沒有覆寫它,所以 channelId 可以自己推導出來。 */
const DEFAULT_SALT = `0x${"0".repeat(64)}` as const;

/** 推導 channelId 需要的最小 requirements 形狀。 */
export type ChannelRequirements = {
  network: string;
  payTo: string;
  asset: string;
  extra?: { receiverAuthorizer?: string; withdrawDelay?: number };
};

export type WalletOverrides = Readonly<{
  /** 換掉押金政策。合約測試用它模擬「買方不再補押金」,藉此逼出賣方的押金守門。 */
  depositStrategy?: BatchSettlementDepositStrategy;
}>;

export function createWallet(config: AppConfig, overrides: WalletOverrides = {}) {
  const account = privateKeyToAccount(config.agentPrivateKey as `0x${string}`);
  // 必須補上 readContract:recoverChannel 與 corrective 402 的復原都靠它讀鏈上狀態。
  // 只給裸 account 的話,一旦本地 channel 紀錄與鏈上失步(例如退款後),
  // 買方會永遠卡在 402,除非有人手動刪掉 channel 檔(spec §7)。
  const publicClient = createPublicClient({
    chain: avalancheFuji,
    transport: http(config.fujiRpcUrl),
  });
  const signer = toClientEvmSigner(account, publicClient as never);
  const storage = new FileClientChannelStorage({ directory: config.channelStorageDir });
  const scheme = new BatchSettlementEvmScheme(signer, {
    storage,
    depositStrategy: overrides.depositStrategy ?? configuredDepositStrategy(config),
  });

  const client = x402Client.fromConfig({
    schemes: [{ network: "eip155:*", client: scheme }],
    spendControls: {
      allowedAssets: [
        {
          network: FUJI_USDC.network,
          asset: FUJI_USDC.address,
          maxAmountPerPayment: config.pricePerTickAtomic.toString(),
        },
      ],
    },
  });

  return {
    account,
    signer,
    scheme,
    storage,
    client,
    httpClient: new x402HTTPClient(client),
    paidFetch: wrapFetchWithPayment(fetch, client),
    refund: () => refundChannel(scheme as any, `${config.serverBaseUrl}/tick`),

    /**
     * 丟掉本地的 channel 紀錄,讓下一次付款改由 recoverChannel 從鏈上重建。
     *
     * 賣方端的閒置退款(REFUND_IDLE_SECS)不會通知買方,而套件的 corrective 復原
     * 只認 cumulative_amount_mismatch 與 cumulative_amount_below_claimed 兩種錯誤 ——
     * 退款造成的 cumulative_exceeds_balance 不在其中。少了這條路,買方會抱著
     * 一份「餘額還有 50000」的過期紀錄永遠卡在 402(spec §7)。
     */
    forgetChannel: async (accepted: ChannelRequirements): Promise<void> => {
      const channelConfig = buildChannelConfig(
        { signer, salt: DEFAULT_SALT } as never,
        accepted as never,
      );
      await storage.delete(computeChannelId(channelConfig, accepted.network).toLowerCase());
    },
  };
}
