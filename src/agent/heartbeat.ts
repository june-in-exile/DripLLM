import type { AppConfig } from "../config.js";
import type { createWallet } from "./wallet.js";

export type PayResult = Readonly<{ sessionId: string; txHash: string }>;

/** sessionId 已被剪除且仍在 tombstone 期間 —— 付款已被 middleware 取消,未扣款。 */
export class SessionCutError extends Error {
  constructor() {
    super("此 sessionId 已被剪除,需改用新的 sessionId");
    this.name = "SessionCutError";
  }
}

export async function payTick(
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
    const detail = await res.text().catch(() => "");
    if (/insufficient|balance|funds/i.test(detail)) {
      throw new Error("USDC 餘額不足 —— 前往 Circle faucet 領取");
    }
    throw new Error(`付款失敗:HTTP ${res.status} ${detail}`);
  }

  const body = (await res.json()) as { sessionId: string };
  // txHash 走 header,不在 body 中(spec §2.5)
  const settle = wallet.httpClient.getPaymentSettleResponse((n) => res.headers.get(n));

  return { sessionId: body.sessionId, txHash: settle.transaction };
}
