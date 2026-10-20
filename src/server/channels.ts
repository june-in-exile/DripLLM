import { z } from "zod";

export interface ChannelAmounts {
  balance: string;
  chargedCumulativeAmount: string;
  totalClaimed: string;
}

const ATOMIC = /^\d+$/;

/**
 * The channelState in the settle response is the merged result of the facilitator and the package scheme,
 * so it is external input — every field is required, otherwise the gate would decide on incomplete numbers.
 */
const channelAmountsSchema = z.object({
  balance: z.string().regex(ATOMIC),
  chargedCumulativeAmount: z.string().regex(ATOMIC),
  totalClaimed: z.string().regex(ATOMIC),
});

/** Returns null if the full amounts can't be parsed; the caller decides whether to let it through — no guessing, no defaulting to 0. */
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

/**
 * The refund amount is balance − chargedCumulativeAmount. When it is 0 the contract reverts with ZeroRefund,
 * so a channel whose deposit is used up should not go on the refund list.
 */
export function hasRefundableBalance(
  channel: Pick<ChannelAmounts, "balance" | "chargedCumulativeAmount">,
): boolean {
  return BigInt(channel.balance) > BigInt(channel.chargedCumulativeAmount);
}

export function remainingTicks(channel: ChannelAmounts, priceAtomic: bigint): number {
  if (priceAtomic <= 0n) throw new RangeError("priceAtomic must be greater than 0");
  return Number(remainingAtomic(channel) / priceAtomic);
}

export function needsDepositTopUp(
  channel: ChannelAmounts,
  thresholdAtomic: bigint,
): boolean {
  if (thresholdAtomic < 0n) throw new RangeError("thresholdAtomic must not be negative");
  return remainingAtomic(channel) < thresholdAtomic;
}

export function withdrawDeadlineMs(
  channel: Pick<{ withdrawRequestedAt: number }, "withdrawRequestedAt">,
  withdrawDelaySecs: number,
): number | null {
  // withdrawRequestedAt is the block timestamp (seconds) written by the contract; 0 when no withdrawal has been requested.
  if (channel.withdrawRequestedAt <= 0) return null;
  return (channel.withdrawRequestedAt + withdrawDelaySecs) * 1_000;
}
