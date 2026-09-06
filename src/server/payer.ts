export class PayerUnknownError extends Error {
  constructor() {
    super("無法確認付款者身分,拒絕建立 session");
    this.name = "PayerUnknownError";
  }
}

type MaybeExactPayload = {
  authorization?: { from?: unknown };
};

function asAddress(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v.toLowerCase() : null;
}

/**
 * 付款者身分的唯一來源。
 * authorization.from 為必填且屬 EIP-712 簽章的一部分;SettleResponse.payer 為 optional,
 * 僅作後備。兩者皆空時必須拋錯 —— 綁定 undefined 會讓 payer 比對恆為真(spec §2.6)。
 */
export function extractPayer(payload: unknown, settlePayer?: string): string {
  const from =
    typeof payload === "object" && payload !== null
      ? asAddress((payload as MaybeExactPayload).authorization?.from)
      : null;

  const fallback = asAddress(settlePayer);
  const payer = from ?? fallback;
  if (payer === null) throw new PayerUnknownError();
  return payer;
}
