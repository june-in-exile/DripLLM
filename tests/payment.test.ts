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

// 起一個真的假 facilitator,resourceServer 啟動時的 /supported 同步才不會噴錯
let fake: Awaited<ReturnType<typeof startFakeFacilitator>>;

beforeAll(async () => {
  fake = await startFakeFacilitator();
});

afterAll(async () => {
  // resourceServer 的 /supported 同步是背景 promise,等它落地再關,否則 teardown 會噴 unhandled rejection
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
  it("位址取自私鑰,且真的簽得出 EIP-712", async () => {
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

describe("402 要求中的 receiverAuthorizer 歸屬(spec §2.4 / §3.1)", () => {
  it("設了賣方授權私鑰時,由賣方自己擔任 receiverAuthorizer", async () => {
    const extra = await advertisedExtra(
      testConfig({ LLM_PROVIDER_AUTHORIZER_PRIVATE_KEY: SELLER_AUTHORIZER_KEY }),
    );
    expect(extra.receiverAuthorizer).toBe(privateKeyToAccount(SELLER_AUTHORIZER_KEY).address);
  });

  it("未設私鑰時委派給 facilitator 廣告的位址", async () => {
    const extra = await advertisedExtra(testConfig());
    expect(extra.receiverAuthorizer).toBe(getAddress(FACILITATOR_AUTHORIZER));
  });

  it("一律把 withdrawDelay 帶給買方,買方才知道非合作提領要等多久", async () => {
    const config = testConfig({ WITHDRAW_DELAY_SECS: "900" });
    const extra = await advertisedExtra(config);
    expect(extra.withdrawDelay).toBe(config.withdrawDelaySecs);
  });
});
