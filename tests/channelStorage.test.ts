import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Channel } from "@x402/evm/batch-settlement/server";
import { createServerChannelStorage } from "../src/server/channelStorage.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function storedChannel(channelId: `0x${string}`): Channel {
  return {
    channelId,
    channelConfig: {
      payer: "0x1111111111111111111111111111111111111111",
      payerAuthorizer: "0x1111111111111111111111111111111111111111",
      receiver: "0x2222222222222222222222222222222222222222",
      receiverAuthorizer: "0x3333333333333333333333333333333333333333",
      token: "0x5425890298aed601595a70AB815c96711a31Bc65",
      withdrawDelay: 900,
      salt: `0x${"4".repeat(64)}`,
    },
    chargedCumulativeAmount: "40",
    signedMaxClaimable: "40",
    signature: `0x${"5".repeat(130)}`,
    balance: "50000",
    totalClaimed: "0",
    withdrawRequestedAt: 0,
    refundNonce: 0,
    lastRequestTimestamp: 1_700_000_000_000,
  };
}

describe("createServerChannelStorage", () => {
  it("新 storage instance 可復原先前寫入的最新 voucher", async () => {
    const root = await mkdtemp(join(tmpdir(), "dripllm-channel-"));
    roots.push(root);
    const id = `0x${"a".repeat(64)}` as const;
    const first = createServerChannelStorage(root);
    await first.updateChannel(id, () => storedChannel(id));

    const afterRestart = createServerChannelStorage(root);

    await expect(afterRestart.get(id)).resolves.toMatchObject({
      channelId: id,
      signedMaxClaimable: "40",
      signature: `0x${"5".repeat(130)}`,
    });
  });
});
