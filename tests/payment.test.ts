import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InMemoryChannelStorage } from "@x402/evm/batch-settlement/server";
import { privateKeyToAccount } from "viem/accounts";
import { getAddress } from "viem";
import { createPaymentStack, toReceiverAuthorizerSigner } from "../src/server/payment.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import { FUJI_USDC } from "../src/shared/usdc.js";
import { startFakeFacilitator } from "./helpers/fakeFacilitator.js";

const SELLER_AUTHORIZER_KEY = `0x${"c".repeat(64)}` as const;
const FACILITATOR_AUTHORIZER = "0xdddddddddddddddddddddddddddddddddddddddd";

// Spin up a real fake facilitator so the resourceServer's /supported sync on startup doesn't blow up
let fake: Awaited<ReturnType<typeof startFakeFacilitator>>;

beforeAll(async () => {
  fake = await startFakeFacilitator();
});

afterAll(async () => {
  // The resourceServer's /supported sync is a background promise; wait for it to land before closing, or teardown throws an unhandled rejection
  await new Promise((r) => setTimeout(r, 50));
  await fake.close();
});

function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    FACILITATOR_URL: fake.url,
    FACILITATOR_PRIVATE_KEY: "0x" + "f".repeat(64),
    LLM_PROVIDER_ADDRESS: "0x1234567890123456789012345678901234567890",
    AGENT_PRIVATE_KEY: "0x" + "a".repeat(64),
    ...overrides,
  });
}

const baseRequirements = {
  scheme: "batch-settlement",
  network: FUJI_USDC.network,
  amount: "40",
  asset: FUJI_USDC.address,
  payTo: "0x1234567890123456789012345678901234567890",
  maxTimeoutSeconds: 60,
  extra: {},
} as never;

const facilitatorKind = {
  x402Version: 2,
  scheme: "batch-settlement",
  network: FUJI_USDC.network,
  extra: { receiverAuthorizer: FACILITATOR_AUTHORIZER },
};

async function advertisedExtra(config: AppConfig): Promise<Record<string, unknown>> {
  const stack = createPaymentStack(config, new InMemoryChannelStorage(), async () => {});
  const enhanced = await stack.scheme.enhancePaymentRequirements(
    baseRequirements,
    facilitatorKind,
    [],
  );
  return (enhanced.extra ?? {}) as Record<string, unknown>;
}

describe("toReceiverAuthorizerSigner", () => {
  it("derives the address from the private key and can really sign EIP-712", async () => {
    const signer = toReceiverAuthorizerSigner(SELLER_AUTHORIZER_KEY);
    expect(signer.address).toBe(privateKeyToAccount(SELLER_AUTHORIZER_KEY).address);

    const signature = await signer.signTypedData({
      domain: { name: "x402 Batch Settlement", version: "1", chainId: 43113 },
      types: { Probe: [{ name: "value", type: "uint256" }] },
      primaryType: "Probe",
      message: { value: 1n },
    });
    expect(signature).toMatch(/^0x[0-9a-f]+$/i);
  });
});

describe("who owns receiverAuthorizer in the 402 requirements (spec §2.4 / §3.1)", () => {
  it("with the seller authorizer private key set, the seller acts as receiverAuthorizer itself", async () => {
    const extra = await advertisedExtra(
      testConfig({ LLM_PROVIDER_AUTHORIZER_PRIVATE_KEY: SELLER_AUTHORIZER_KEY }),
    );
    expect(extra.receiverAuthorizer).toBe(privateKeyToAccount(SELLER_AUTHORIZER_KEY).address);
  });

  it("without a private key, delegates to the address the facilitator advertises", async () => {
    const extra = await advertisedExtra(testConfig());
    expect(extra.receiverAuthorizer).toBe(getAddress(FACILITATOR_AUTHORIZER));
  });

  it("always passes withdrawDelay to the buyer, so it knows how long a non-cooperative withdrawal takes", async () => {
    const config = testConfig({ WITHDRAW_DELAY_SECS: "900" });
    const extra = await advertisedExtra(config);
    expect(extra.withdrawDelay).toBe(config.withdrawDelaySecs);
  });
});
