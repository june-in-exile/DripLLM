import express from "express";
import type { Server } from "node:http";
import { getAddress, verifyTypedData } from "viem";
import { BATCH_SETTLEMENT_ADDRESS, BATCH_SETTLEMENT_DOMAIN, voucherTypes } from "@x402/evm";

const FUJI_CHAIN_ID = 43113;

type ChannelState = { balance: bigint; totalClaimed: bigint };

type VoucherPayload = {
  type?: string;
  channelConfig?: { payer?: string; payerAuthorizer?: string };
  voucher?: { channelId?: string; maxClaimableAmount?: string; signature?: string };
  deposit?: { amount?: string };
  authorization?: { from?: string };
};

function invalid(reason: string, payer: unknown) {
  return { isValid: false, invalidReason: reason, payer };
}

/** 與正式 facilitator 相同的 EIP-712 檢查:買方的 payerAuthorizer 必須真的簽過這張券。 */
async function voucherSignatureOk(payload: VoucherPayload): Promise<boolean> {
  const authorizer = payload.channelConfig?.payerAuthorizer;
  const voucher = payload.voucher;
  if (!authorizer || !voucher?.channelId || !voucher.maxClaimableAmount || !voucher.signature) {
    return false;
  }
  try {
    return await verifyTypedData({
      address: getAddress(authorizer),
      domain: {
        ...BATCH_SETTLEMENT_DOMAIN,
        chainId: FUJI_CHAIN_ID,
        verifyingContract: getAddress(BATCH_SETTLEMENT_ADDRESS),
      },
      types: voucherTypes,
      primaryType: "Voucher",
      message: {
        channelId: voucher.channelId as `0x${string}`,
        maxClaimableAmount: BigInt(voucher.maxClaimableAmount),
      },
      signature: voucher.signature as `0x${string}`,
    });
  } catch {
    return false;
  }
}

function stateExtra(channelId: string, state: ChannelState) {
  return {
    channelId,
    balance: state.balance.toString(),
    totalClaimed: state.totalClaimed.toString(),
    withdrawRequestedAt: 0,
    refundNonce: "0",
  };
}

/**
 * 假 facilitator。記帳與簽章驗證都是真的,唯一省略的是上鏈 ——
 * 這樣合約測試才能真的證明「押金耗盡就不送 token」而不是只證明 HTTP 有通。
 *
 * syncFacilitatorOnStart 預設為 true,middleware 啟動時會呼叫 /supported。
 */
export async function startFakeFacilitator(port = 0): Promise<{
  url: string;
  close(): Promise<void>;
  settleCount(): number;
  balanceOf(channelId: string): bigint;
}> {
  let settles = 0;
  const channels = new Map<string, ChannelState>();
  const receiverAuthorizer = "0xdddddddddddddddddddddddddddddddddddddddd";
  const app = express();
  app.use(express.json());

  app.get("/supported", (_req, res) => {
    res.json({
      kinds: [
        {
          x402Version: 2,
          scheme: "batch-settlement",
          network: "eip155:43113",
          extra: { receiverAuthorizer },
        },
      ],
      extensions: [],
      signers: { "eip155:43113": [receiverAuthorizer] },
    });
  });

  app.post("/verify", async (req, res) => {
    const payload = (req.body?.paymentPayload?.payload ?? {}) as VoucherPayload;
    const payer = payload.channelConfig?.payer ?? payload.authorization?.from;

    // contract.test.ts 的 exact 形狀 payload:沒有 type,維持一律放行的舊行為。
    if (typeof payload.type !== "string") {
      res.json({ isValid: true, payer, extra: stateExtra("", { balance: 0n, totalClaimed: 0n }) });
      return;
    }
    if (!(await voucherSignatureOk(payload))) {
      res.json(invalid("invalid_batch_settlement_evm_invalid_voucher_signature", payer));
      return;
    }

    const channelId = String(payload.voucher?.channelId ?? "");
    const state = channels.get(channelId.toLowerCase());
    if (payload.type === "deposit") {
      res.json({
        isValid: true,
        payer,
        extra: stateExtra(channelId, state ?? { balance: 0n, totalClaimed: 0n }),
      });
      return;
    }
    if (!state || state.balance === 0n) {
      res.json(invalid("invalid_batch_settlement_evm_channel_not_found", payer));
      return;
    }
    const maxClaimable = BigInt(payload.voucher?.maxClaimableAmount ?? "0");
    if (maxClaimable > state.balance) {
      res.json(invalid("invalid_batch_settlement_evm_cumulative_exceeds_balance", payer));
      return;
    }
    if (maxClaimable <= state.totalClaimed) {
      res.json(invalid("invalid_batch_settlement_evm_cumulative_amount_below_claimed", payer));
      return;
    }
    res.json({ isValid: true, payer, extra: stateExtra(channelId, state) });
  });

  app.post("/settle", (req, res) => {
    settles += 1;
    const payload = (req.body?.paymentPayload?.payload ?? {}) as VoucherPayload;
    const channelId = String(payload.voucher?.channelId ?? "");
    const key = channelId.toLowerCase();
    let state = channels.get(key);
    if (payload.type === "deposit" && channelId) {
      state = {
        balance: (state?.balance ?? 0n) + BigInt(payload.deposit?.amount ?? "0"),
        totalClaimed: state?.totalClaimed ?? 0n,
      };
      channels.set(key, state);
    }
    res.json({
      success: true,
      transaction: `0xfaketx${settles}`,
      network: "eip155:43113",
      payer: payload.channelConfig?.payer ?? payload.authorization?.from,
      extra: state ? { channelState: stateExtra(channelId, state) } : undefined,
    });
  });

  const server: Server = await new Promise((resolve) => {
    const s = app.listen(port, () => resolve(s));
  });
  const addr = server.address();
  const actualPort = typeof addr === "object" && addr ? addr.port : port;

  return {
    url: `http://localhost:${actualPort}`,
    settleCount: () => settles,
    balanceOf: (channelId: string) => channels.get(channelId.toLowerCase())?.balance ?? 0n,
    close: () => new Promise((r) => server.close(() => r())),
  };
}
