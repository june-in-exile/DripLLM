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
 * Narrows a viem account into the receiver-authorizer signer the package expects.
 * viem's signTypedData generics are narrower than AuthorizerSigner's structural interface; runtime behavior is the same.
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
  // With a private key, the seller signs claim/refund authorizations itself (spec §2.4); otherwise it delegates to the facilitator,
  // in which case the package's validateFacilitatorSupport requires /supported to advertise a receiverAuthorizer.
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
    description: "DripLLM streaming time",
    mimeType: "application/json",
  } as const;
  const middleware = paymentMiddleware(
    {
      "POST /tick": tickResource,
      // The @x402 batch client's cooperative refund fetches requirements via a GET probe on the same path.
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
