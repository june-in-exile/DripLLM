import { z } from "zod";

export interface ChannelAmounts {
  balance: string;
  chargedCumulativeAmount: string;
  totalClaimed: string;
}

const ATOMIC = /^\d+$/;

/**
 * settle 回應裡的 channelState 來自 facilitator 與套件 scheme 的合併結果,
 * 是外部輸入 —— 欄位缺一不可,否則守門會用殘缺的數字做判斷。
 */
const channelAmountsSchema = z.object({
  balance: z.string().regex(ATOMIC),
  chargedCumulativeAmount: z.string().regex(ATOMIC),
  totalClaimed: z.string().regex(ATOMIC),
});

/** 解析不出完整金額就回 null,由呼叫端決定要不要放行 —— 不猜、不補 0。 */
export function parseChannelAmounts(value: unknown): ChannelAmounts | null {
  const parsed = channelAmountsSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function remainingAtomic(channel: ChannelAmounts): bigint {
  const remaining = BigInt(channel.balance) - BigInt(channel.chargedCumulativeAmount);
  return remaining > 0n ? remaining : 0n;
}

export function canServe(channel: ChannelAmounts, priceAtomic: bigint): boolean {
  return remainingAtomic(channel) >= priceAtomic;
}

export function remainingTicks(channel: ChannelAmounts, priceAtomic: bigint): number {
  if (priceAtomic <= 0n) throw new RangeError("priceAtomic 必須大於 0");
  return Number(remainingAtomic(channel) / priceAtomic);
}

export function needsDepositTopUp(
  channel: ChannelAmounts,
  thresholdAtomic: bigint,
): boolean {
  if (thresholdAtomic < 0n) throw new RangeError("thresholdAtomic 不可為負值");
  return remainingAtomic(channel) < thresholdAtomic;
}

export function withdrawDeadlineMs(
  channel: Pick<{ withdrawRequestedAt: number }, "withdrawRequestedAt">,
  withdrawDelaySecs: number,
): number | null {
  // withdrawRequestedAt 是合約寫入的區塊時間戳(秒),未申請提領時為 0。
  if (channel.withdrawRequestedAt <= 0) return null;
  return (channel.withdrawRequestedAt + withdrawDelaySecs) * 1_000;
}
