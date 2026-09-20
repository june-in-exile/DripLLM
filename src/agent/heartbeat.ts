import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { ChannelRequirements, createWallet } from "./wallet.js";

export type PayResult = Readonly<{
  sessionId: string;
  txHash: string | undefined;
  channelBalance?: string;
  signedCeiling?: string;
  chargedCumulative?: string;
}>;

/** sessionId 已被剪除且仍在 tombstone 期間 —— 付款已被 middleware 取消,未扣款。 */
export class SessionCutError extends Error {
  constructor() {
    super("此 sessionId 已被剪除,需改用新的 sessionId");
    this.name = "SessionCutError";
  }
}

/**
 * 本地 channel 紀錄與鏈上失步(通常是賣方端退款過)。
 * 丟掉紀錄重試一次就能由 recoverChannel 從鏈上重建。
 */
class StaleChannelError extends Error {
  constructor(readonly accepted: ChannelRequirements) {
    super("本地 channel 紀錄已過期");
    this.name = "StaleChannelError";
  }
}

/** 402 的付款要求與拒絕原因都放在 PAYMENT-REQUIRED header,body 是空物件。 */
function decodePaymentRequired(res: Response): {
  error: string;
  accepted: ChannelRequirements | undefined;
} {
  const encoded = res.headers.get("payment-required");
  if (!encoded) return { error: "", accepted: undefined };
  try {
    const decoded = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as {
      error?: unknown;
      accepts?: ChannelRequirements[];
    };
    return {
      error: typeof decoded.error === "string" ? decoded.error : "",
      accepted: decoded.accepts?.[0],
    };
  } catch {
    return { error: "", accepted: undefined };
  }
}

/** settle 回應的 extra 由 server 與 facilitator 合併產生,對 agent 而言是外部輸入。 */
const settleExtraSchema = z.object({
  channelState: z
    .object({
      channelId: z.string().optional(),
      balance: z.string().optional(),
      chargedCumulativeAmount: z.string().optional(),
    })
    .optional(),
});

/**
 * 付一格。本地 channel 紀錄過期時自動丟棄並重試一次 ——
 * 只重試一次,避免鏈上真的沒錢時陷入無限迴圈。
 */
export async function payTick(
  wallet: ReturnType<typeof createWallet>,
  config: AppConfig,
  sessionId: string,
): Promise<PayResult> {
  try {
    return await attemptTick(wallet, config, sessionId);
  } catch (e) {
    if (!(e instanceof StaleChannelError)) throw e;
    await wallet.forgetChannel(e.accepted);
  }
  try {
    return await attemptTick(wallet, config, sessionId);
  } catch (e) {
    // 從鏈上重建後還是不夠 —— 這次是真的沒押金,且補不進來。
    if (e instanceof StaleChannelError) {
      throw new Error("押金不足以支付下一格,且未能補上押金 —— 請確認買方錢包的 USDC 餘額");
    }
    throw e;
  }
}

async function attemptTick(
  wallet: ReturnType<typeof createWallet>,
  config: AppConfig,
  sessionId: string,
): Promise<PayResult> {
  const res = await wallet.paidFetch(`${config.serverBaseUrl}/tick`, {
    method: "POST",
    headers: { "X-Drip-Session": sessionId, "Content-Type": "application/json" },
    body: "{}",
  });

  if (res.status === 409) throw new SessionCutError();
  if (!res.ok) {
    const { error: reason, accepted } = res.status === 402
      ? decodePaymentRequired(res)
      : { error: "", accepted: undefined };
    const detail = (await res.text().catch(() => "")) || reason;
    // 上限超過押金餘額 = 本地紀錄比鏈上樂觀,丟掉重來一次就好。
    if (reason.includes("cumulative_exceeds_balance") && accepted) {
      throw new StaleChannelError(accepted);
    }
    // 只認錢包層的餘額不足。不可寫成鬆散的 /balance/ ——
    // 那會把 channel 的 cumulative_exceeds_balance 一起誤判成錢包沒錢。
    if (res.status === 402 && /insufficient[ _-]?(funds|balance)/i.test(`${reason} ${detail}`)) {
      throw new Error(`USDC 餘額不足 —— 前往 Circle faucet 領取(${reason || detail})`);
    }
    throw new Error(`付款失敗:HTTP ${res.status}${reason ? ` ${reason}` : ""} ${detail}`.trim());
  }

  const body = (await res.json()) as { sessionId: string };
  // txHash 走 header,不在 body 中(spec §2.5)
  const settle = wallet.httpClient.getPaymentSettleResponse((n) => res.headers.get(n));
  const parsed = settleExtraSchema.safeParse(settle.extra);
  const channelState = parsed.success ? parsed.data.channelState : undefined;
  const channelId = channelState?.channelId;
  const clientChannel = channelId ? await wallet.storage.get(channelId) : undefined;

  return {
    sessionId: body.sessionId,
    txHash: settle.transaction || undefined,
    channelBalance: channelState?.balance,
    // 曝險是「已簽的上限」,不是「已消耗」(spec §2.4)。套件只在 corrective recovery
    // 後才寫 signedMaxClaimable,平常兩者相等,所以退回已消耗作為近似值。
    signedCeiling: clientChannel?.signedMaxClaimable ?? clientChannel?.chargedCumulativeAmount,
    chargedCumulative: channelState?.chargedCumulativeAmount,
  };
}
