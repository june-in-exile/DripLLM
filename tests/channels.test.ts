import { describe, expect, it } from "vitest";
import {
  canServe,
  hasRefundableBalance,
  needsDepositTopUp,
  parseChannelAmounts,
  remainingTicks,
  withdrawDeadlineMs,
} from "../src/server/channels.js";

type ChannelAmounts = {
  balance: string;
  chargedCumulativeAmount: string;
  totalClaimed: string;
};

function channel(
  balance: bigint,
  chargedCumulativeAmount: bigint,
  totalClaimed: bigint,
): ChannelAmounts {
  return {
    balance: balance.toString(),
    chargedCumulativeAmount: chargedCumulativeAmount.toString(),
    totalClaimed: totalClaimed.toString(),
  };
}

describe("canServe — deposit gate", () => {
  it("unclaimed served amount still occupies the deposit", () => {
    const fullyConsumed = channel(100n, 100n, 0n);

    expect(canServe(fullyConsumed, 40n)).toBe(false);
  });

  it("claiming served amount doesn't restore serviceable credit", () => {
    const claimed = channel(100n, 100n, 100n);

    expect(canServe(claimed, 40n)).toBe(false);
  });

  it("allows service when remaining credit is exactly one tick", () => {
    const exact = channel(100n, 60n, 0n);

    expect(canServe(exact, 40n)).toBe(true);
  });

  it("refuses service when remaining credit is 1 atomic short of one tick", () => {
    const oneShort = channel(100n, 61n, 0n);

    expect(canServe(oneShort, 40n)).toBe(false);
  });

  it("restores serviceable credit after a top-up increases balance", () => {
    const toppedUp = channel(140n, 100n, 0n);

    expect(canServe(toppedUp, 40n)).toBe(true);
  });
});

describe("remainingTicks", () => {
  it("subtracts chargedCumulativeAmount from balance and rounds down", () => {
    const unclaimedUsage = channel(1_000n, 610n, 0n);

    expect(remainingTicks(unclaimedUsage, 40n)).toBe(9);
  });

  it("changes in totalClaimed don't affect remaining ticks", () => {
    const beforeClaim = channel(1_000n, 600n, 0n);
    const afterClaim = channel(1_000n, 600n, 600n);

    expect(remainingTicks(beforeClaim, 40n)).toBe(10);
    expect(remainingTicks(afterClaim, 40n)).toBe(10);
  });

  it("doesn't return negative ticks when consumed exceeds balance", () => {
    const inconsistent = channel(100n, 101n, 0n);

    expect(remainingTicks(inconsistent, 40n)).toBe(0);
  });
});

describe("needsDepositTopUp", () => {
  it("doesn't top up the deposit when serviceable balance equals the threshold exactly", () => {
    expect(needsDepositTopUp(channel(5_040n, 40n, 0n), 5_000n)).toBe(false);
  });

  it("tops up the deposit when serviceable balance is 1 atomic below the threshold", () => {
    expect(needsDepositTopUp(channel(5_039n, 40n, 0n), 5_000n)).toBe(true);
  });

  it("computes balance from served amount, not totalClaimed", () => {
    expect(needsDepositTopUp(channel(10_000n, 6_000n, 6_000n), 5_000n)).toBe(true);
  });
});

describe("withdrawDeadlineMs", () => {
  it("has no deadline when no withdrawal has been requested", () => {
    expect(withdrawDeadlineMs({ withdrawRequestedAt: 0 }, 900)).toBeNull();
  });

  it("converts the on-chain second-based timestamp and delay into a millisecond deadline", () => {
    expect(withdrawDeadlineMs({ withdrawRequestedAt: 1_700_000_000 }, 900)).toBe(
      1_700_000_900_000,
    );
  });
});

describe("gate function guards", () => {
  it("price must not be 0 or negative — otherwise remaining ticks would be infinite", () => {
    expect(() => remainingTicks(channel(100n, 0n, 0n), 0n)).toThrow(RangeError);
    expect(() => remainingTicks(channel(100n, 0n, 0n), -1n)).toThrow(RangeError);
  });

  it("top-up threshold must not be negative", () => {
    expect(() => needsDepositTopUp(channel(100n, 0n, 0n), -1n)).toThrow(RangeError);
  });
});

describe("parseChannelAmounts — numbers from the facilitator must be validated first", () => {
  it("passes only when all three fields are present and are decimal integer strings", () => {
    expect(parseChannelAmounts({
      balance: "50000",
      chargedCumulativeAmount: "40",
      totalClaimed: "0",
    })).toEqual({ balance: "50000", chargedCumulativeAmount: "40", totalClaimed: "0" });
  });

  it("returns null whenever fields are missing, mistyped, or not numeric strings — no guessing, no defaulting to 0", () => {
    expect(parseChannelAmounts(undefined)).toBeNull();
    expect(parseChannelAmounts("not-an-object")).toBeNull();
    expect(parseChannelAmounts({ balance: "50000" })).toBeNull();
    expect(parseChannelAmounts({
      balance: "50000",
      chargedCumulativeAmount: 40,
      totalClaimed: "0",
    })).toBeNull();
    expect(parseChannelAmounts({
      balance: "-1",
      chargedCumulativeAmount: "40",
      totalClaimed: "0",
    })).toBeNull();
  });
});

describe("hasRefundableBalance — guard before refunding", () => {
  it("has nothing to refund when the deposit is fully consumed", () => {
    expect(hasRefundableBalance(channel(11720n, 11720n, 11720n))).toBe(false);
  });

  it("can't refund the consumed but unclaimed portion", () => {
    expect(hasRefundableBalance(channel(100n, 100n, 0n))).toBe(false);
  });

  it("can refund while unconsumed deposit remains", () => {
    expect(hasRefundableBalance(channel(11720n, 11680n, 11680n))).toBe(true);
  });
});
