import { x402Client, wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { FUJI_USDC } from "../shared/usdc.js";
import type { AppConfig } from "../config.js";

export function createWallet(config: AppConfig) {
  const signer = privateKeyToAccount(config.agentPrivateKey as `0x${string}`);

  // Fuji 不在 DEFAULT_ASSETS 中,預設的 spendControls 會直接拒付(spec §3.3.1)。
  // @x402 2.25.0 的建構式只收 paymentRequirementsSelector,組態物件走 fromConfig。
  const client = x402Client.fromConfig({
    schemes: [{ network: "eip155:*", client: new ExactEvmScheme(signer) }],
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
    signer,
    client,
    httpClient: new x402HTTPClient(client),
    paidFetch: wrapFetchWithPayment(fetch, client),
  };
}
