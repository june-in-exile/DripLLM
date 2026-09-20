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

/** 組一個帶 PAYMENT-REQUIRED header 的 402,header 裡才是真正的拒絕原因。 */
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

describe("payTick 的失敗路徑", () => {
  it("409 轉成 SessionCutError —— 付款已被取消,未扣款", async () => {
    const wallet = walletReturning(jsonResponse({ error: "已剪除" }, 409));
    await expect(payTick(wallet, config, "s1")).rejects.toBeInstanceOf(SessionCutError);
  });

  it("402 且訊息指向錢包餘額時,給的是去 faucet 領錢的提示", async () => {
    const wallet = walletReturning(new Response("insufficient funds", { status: 402 }));
    await expect(payTick(wallet, config, "s1")).rejects.toThrow(/faucet/);
  });

  it("channel 的 cumulative_exceeds_balance 不可被誤判成錢包沒錢", async () => {
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

    // 第一次丟掉本地紀錄重試,第二次仍失敗才放棄 —— 訊息必須指向押金而非 faucet
    await expect(payTick(wallet, config, "s1")).rejects.toThrow(/押金不足以支付下一格/);
    expect(calls).toBe(2);
    expect(forgotten).toEqual([ACCEPTED]);
  });

  it("本地紀錄過期時丟掉重試一次就能成功(賣方端退款後的情境,spec §7)", async () => {
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

  it("402 但不是餘額問題時走通用訊息,不誤導使用者去領錢", async () => {
    const wallet = walletReturning(
      new Response("invalid_batch_settlement_evm_voucher_signature", { status: 402 }),
    );
    await expect(payTick(wallet, config, "s1")).rejects.toThrow(/HTTP 402/);
  });

  it("其他狀態碼一律通用訊息", async () => {
    const wallet = walletReturning(new Response("boom", { status: 500 }));
    await expect(payTick(wallet, config, "s1")).rejects.toThrow(/HTTP 500/);
  });
});

describe("payTick 的 channel 欄位", () => {
  it("settle extra 形狀不符時不炸,只是沒有 channel 數字可顯示", async () => {
    const wallet = walletReturning(jsonResponse({ sessionId: "s1" }, 200), {
      transaction: "0xtx",
      extra: { channelState: "not-an-object" },
    });
    const result = await payTick(wallet, config, "s1");
    expect(result.sessionId).toBe("s1");
    expect(result.channelBalance).toBeUndefined();
    expect(result.signedCeiling).toBeUndefined();
  });

  it("voucher 結算沒有交易雜湊,txHash 為 undefined 而不是空字串", async () => {
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
    // 曝險看的是已簽上限,不是已消耗(spec §2.4)
    expect(result.signedCeiling).toBe("80");
  });
});
