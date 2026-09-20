import { x402Facilitator } from "@x402/core/facilitator";
import { BatchSettlementEvmScheme } from "@x402/evm/batch-settlement/facilitator";
import { toFacilitatorEvmSigner } from "@x402/evm";
import { createWalletClient, http, publicActions } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { avalancheFuji } from "viem/chains";
import type { AppConfig } from "../config.js";
import { FUJI_USDC } from "../shared/usdc.js";

/**
 * 組出自架 facilitator(spec §2.7)。
 *
 * 抽成獨立函式是為了讓 `/supported` 的形狀能被測到 —— 它不碰網路,
 * 但錯了會讓 resource server 在啟動同步時判定整份 payload 無效,所有付款變 502。
 */
export function buildFacilitator(config: AppConfig): x402Facilitator {
  const account = privateKeyToAccount(config.facilitatorPrivateKey as `0x${string}`);
  const client = createWalletClient({
    account,
    chain: avalancheFuji,
    // viem 對 Fuji 的預設輪詢是 2000ms(chain 沒有 blockTime,退回 4000ms 再取半)。
    pollingInterval: config.facilitatorPollingMs,
    transport: http(config.fujiRpcUrl),
  }).extend(publicActions);

  // toFacilitatorEvmSigner 的 getAddresses() 讀的是扁平的 client.address,
  // 而 viem 的 WalletClient 只有 client.account.address —— 少了這行,
  // /supported 的 signers 會變成 [null]。
  const signerClient = { ...client, address: account.address };
  // viem 2.56 的 signTypedData 泛型比 x402 的結構型 signer 介面更窄,runtime 方法集合相同;
  // 轉型只用來收斂這個差異,address 已在上面明確補齊。
  const signer = toFacilitatorEvmSigner(
    signerClient as unknown as Parameters<typeof toFacilitatorEvmSigner>[0],
    { confirmationTimeoutMs: config.facilitatorConfirmationTimeoutMs },
  );

  return new x402Facilitator().register(
    FUJI_USDC.network,
    new BatchSettlementEvmScheme(signer, account),
  );
}
