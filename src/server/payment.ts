import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { FUJI_USDC } from "../shared/usdc.js";
import type { AppConfig } from "../config.js";

export function createPaymentMiddleware(
  config: AppConfig,
  onAfterSettle: (ctx: never) => Promise<void>,
) {
  const facilitatorClient = new HTTPFacilitatorClient({ url: config.facilitatorUrl });

  const resourceServer = new x402ResourceServer(facilitatorClient)
    .register(FUJI_USDC.network, new ExactEvmScheme())
    .onAfterSettle(onAfterSettle as never);

  return paymentMiddleware(
    {
      "POST /tick": {
        accepts: {
          scheme: "exact",
          // Fuji 不在 DEFAULT_ASSETS 中,必須顯式指定 AssetAmount(spec §3.3)
          price: {
            amount: config.pricePerTickAtomic.toString(),
            asset: FUJI_USDC.address,
            extra: { name: FUJI_USDC.name, version: FUJI_USDC.version },
          },
          network: FUJI_USDC.network,
          payTo: config.payToAddress,
        },
        description: "DripLLM 串流時間",
        mimeType: "application/json",
      },
    },
    resourceServer,
  );
}
