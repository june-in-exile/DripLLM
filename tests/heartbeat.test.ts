import { describe, it, expect } from "vitest";
import { payTick, SessionCutError } from "../src/agent/heartbeat.js";
import type { AppConfig } from "../src/config.js";
import type { createWallet } from "../src/agent/wallet.js";

const config = { serverBaseUrl: "http://localhost:0" } as AppConfig;

type FakeWallet = ReturnType<typeof createWallet>;

function walletReturning(res: Response, settle: Record<string, unknown> = {}): FakeWallet {
  return {
    paidFetch: async () => res,
    httpClient: { getPaymentSettleResponse: () => settle },
    storage: { get: async () => undefined },
    forgetChannel: async () => {},
  } as unknown as FakeWallet;
}

const ACCEPTED = {
  network: "eip155:43113",
  payTo: "0x1234567890123456789012345678901234567890",
  asset: "0x5425890298aed601595a70AB815c96711a31Bc65",
  extra: { receiverAuthorizer: "0xdddddddddddddddddddddddddddddddddddddddd", withdrawDelay: 900 },
};

/** Build a 402 with a PAYMENT-REQUIRED header; the real rejection reason is in the header. */
function paymentRequired(error: string): Response {
  const body = Buffer.from(JSON.stringify({ error, accepts: [ACCEPTED] }), "utf8").toString("base64");
  return new Response("{}", { status: 402, headers: { "payment-required": body } });
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("payTick failure paths", () => {
  it("409 becomes SessionCutError -- payment was cancelled, nothing charged", async () => {
    const wallet = walletReturning(jsonResponse({ error: "cut" }, 409));
    await expect(payTick(wallet, config, "s1")).rejects.toBeInstanceOf(SessionCutError);
  });

  it("a 402 pointing at the wallet balance gives a hint to get funds from the faucet", async () => {
    const wallet = walletReturning(new Response("insufficient funds", { status: 402 }));
    await expect(payTick(wallet, config, "s1")).rejects.toThrow(/faucet/);
  });

  it("the channel's cumulative_exceeds_balance is not mistaken for an empty wallet", async () => {
    let calls = 0;
    const forgotten: unknown[] = [];
    const wallet = {
      paidFetch: async () => {
        calls += 1;
        return paymentRequired("invalid_batch_settlement_evm_cumulative_exceeds_balance");
      },
      httpClient: { getPaymentSettleResponse: () => ({}) },
      storage: { get: async () => undefined },
      forgetChannel: async (a: unknown) => {
        forgotten.push(a);
      },
    } as unknown as FakeWallet;

    // First drop the local record and retry; give up only if the second try also fails -- the message must point to the deposit, not the faucet
    await expect(payTick(wallet, config, "s1")).rejects.toThrow(/Deposit cannot cover the next tick/);
    expect(calls).toBe(2);
    expect(forgotten).toEqual([ACCEPTED]);
  });

  it("a stale local record succeeds after one drop-and-retry (after a seller-side refund, spec §7)", async () => {
    let calls = 0;
    const wallet = {
      paidFetch: async () => {
        calls += 1;
        return calls === 1
          ? paymentRequired("invalid_batch_settlement_evm_cumulative_exceeds_balance")
          : jsonResponse({ sessionId: "s1" }, 200);
      },
      httpClient: { getPaymentSettleResponse: () => ({ transaction: "0xdeposit" }) },
      storage: { get: async () => undefined },
      forgetChannel: async () => {},
    } as unknown as FakeWallet;

    const result = await payTick(wallet, config, "s1");
    expect(result.sessionId).toBe("s1");
    expect(result.txHash).toBe("0xdeposit");
    expect(calls).toBe(2);
  });

  it("a 402 that isn't a balance problem gets the generic message, not a misleading faucet hint", async () => {
    const wallet = walletReturning(
      new Response("invalid_batch_settlement_evm_voucher_signature", { status: 402 }),
    );
    await expect(payTick(wallet, config, "s1")).rejects.toThrow(/HTTP 402/);
  });

  it("any other status code gets the generic message", async () => {
    const wallet = walletReturning(new Response("boom", { status: 500 }));
    await expect(payTick(wallet, config, "s1")).rejects.toThrow(/HTTP 500/);
  });
});

describe("payTick channel fields", () => {
  it("a malformed settle extra doesn't blow up; there are just no channel numbers to show", async () => {
    const wallet = walletReturning(jsonResponse({ sessionId: "s1" }, 200), {
      transaction: "0xtx",
      extra: { channelState: "not-an-object" },
    });
    const result = await payTick(wallet, config, "s1");
    expect(result.sessionId).toBe("s1");
    expect(result.channelBalance).toBeUndefined();
    expect(result.signedCeiling).toBeUndefined();
  });

  it("voucher settlement has no tx hash; txHash is undefined, not an empty string", async () => {
    const wallet = {
      paidFetch: async () => jsonResponse({ sessionId: "s2" }, 200),
      httpClient: {
        getPaymentSettleResponse: () => ({
          transaction: "",
          extra: {
            channelState: {
              channelId: "0xabc",
              balance: "50000",
              chargedCumulativeAmount: "80",
            },
          },
        }),
      },
      storage: { get: async () => ({ signedMaxClaimable: "80" }) },
    } as unknown as FakeWallet;

    const result = await payTick(wallet, config, "s2");
    expect(result.txHash).toBeUndefined();
    expect(result.channelBalance).toBe("50000");
    // Exposure is the signed cap, not consumed (spec §2.4)
    expect(result.signedCeiling).toBe("80");
  });
});
