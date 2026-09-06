import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { FUJI_USDC } from "../shared/usdc.js";
import type { AppConfig } from "../config.js";

/**
 * API client 的 402 body。v2 middleware 把 requirements 放進 PAYMENT-REQUIRED header,
 * body 預設是空物件 —— 此回呼把價格與資產一併放進 body,讓 agent 不解析 header
 * 也能看到報價(verified in @x402/core dist: createHTTPResponse)。
 */
function unpaidBody(config: AppConfig) {
  return {
    contentType: "application/json",
    body: {
      x402Version: 2,
      error: "Payment required",
      accepts: [
        {
          scheme: "exact",
          network: FUJI_USDC.network,
          asset: FUJI_USDC.address,
          amount: config.pricePerTickAtomic.toString(),
          payTo: config.payToAddress,
          maxTimeoutSeconds: 300,
          extra: { name: FUJI_USDC.name, version: FUJI_USDC.version },
        },
      ],
    },
  };
}

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
        unpaidResponseBody: () => unpaidBody(config),
      },
    },
    resourceServer,
  );
}
