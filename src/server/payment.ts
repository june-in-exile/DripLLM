import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import {
  type AuthorizerSigner,
  BatchSettlementEvmScheme,
  type ChannelStorage,
} from "@x402/evm/batch-settlement/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { privateKeyToAccount } from "viem/accounts";
import { FUJI_USDC } from "../shared/usdc.js";
import type { AppConfig } from "../config.js";

/**
 * 把 viem account 收斂成套件要的 receiver-authorizer signer。
 * viem 的 signTypedData 泛型比 AuthorizerSigner 的結構型介面窄,runtime 行為相同。
 */
export function toReceiverAuthorizerSigner(privateKey: string): AuthorizerSigner {
  const account = privateKeyToAccount(privateKey as `0x${string}`);
  return {
    address: account.address,
    signTypedData: (params) =>
      account.signTypedData(params as Parameters<typeof account.signTypedData>[0]),
  };
}

export function createPaymentStack(
  config: AppConfig,
  storage: ChannelStorage,
  onAfterSettle: (ctx: never) => Promise<void>,
) {
  const facilitatorClient = new HTTPFacilitatorClient({ url: config.facilitatorUrl });
  // 有私鑰就由賣方自己簽 claim/refund 授權(spec §2.4);沒有則委派 facilitator,
  // 此時套件的 validateFacilitatorSupport 會要求 /supported 廣告 receiverAuthorizer。
  const receiverAuthorizerSigner = config.llmProviderAuthorizerPrivateKey
    ? toReceiverAuthorizerSigner(config.llmProviderAuthorizerPrivateKey)
    : undefined;
  const scheme = new BatchSettlementEvmScheme(config.llmProviderAddress as `0x${string}`, {
    storage,
    withdrawDelay: config.withdrawDelaySecs,
    ...(receiverAuthorizerSigner ? { receiverAuthorizerSigner } : {}),
  });
  const resourceServer = new x402ResourceServer(facilitatorClient)
    .register(FUJI_USDC.network, scheme)
    .onAfterSettle(onAfterSettle as never);

  const tickResource = {
    accepts: {
      scheme: "batch-settlement",
      price: {
        amount: config.pricePerTickAtomic.toString(),
        asset: FUJI_USDC.address,
        extra: {
          name: FUJI_USDC.name,
          version: FUJI_USDC.version,
          assetTransferMethod: "eip3009",
        },
      },
      network: FUJI_USDC.network,
      payTo: config.llmProviderAddress,
    },
    description: "DripLLM 串流時間",
    mimeType: "application/json",
  } as const;
  const middleware = paymentMiddleware(
    {
      "POST /tick": tickResource,
      // @x402 batch client 的 cooperative refund 以 GET probe 同一路徑取得 requirements。
      "GET /tick": tickResource,
    },
    resourceServer,
  );

  return {
    middleware,
    scheme,
    storage,
    manager: scheme.createChannelManager(
      facilitatorClient,
      FUJI_USDC.network,
      FUJI_USDC.address,
    ),
  };
}
