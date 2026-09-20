import { describe, expect, it } from "vitest";
import {
  canServe,
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

describe("canServe —— 押金守門", () => {
  it("未 claim 的已提供服務仍會佔用押金", () => {
    const fullyConsumed = channel(100n, 100n, 0n);

    expect(canServe(fullyConsumed, 40n)).toBe(false);
  });

  it("claim 已提供的服務不會恢復可服務額度", () => {
    const claimed = channel(100n, 100n, 100n);

    expect(canServe(claimed, 40n)).toBe(false);
  });

  it("剩餘額度剛好等於一格時允許服務", () => {
    const exact = channel(100n, 60n, 0n);

    expect(canServe(exact, 40n)).toBe(true);
  });

  it("剩餘額度比一格少 1 atomic 時拒絕服務", () => {
    const oneShort = channel(100n, 61n, 0n);

    expect(canServe(oneShort, 40n)).toBe(false);
  });

  it("top-up 增加 balance 後恢復可服務額度", () => {
    const toppedUp = channel(140n, 100n, 0n);

    expect(canServe(toppedUp, 40n)).toBe(true);
  });
});

describe("remainingTicks", () => {
  it("以 balance 減去 chargedCumulativeAmount 並向下取整", () => {
    const unclaimedUsage = channel(1_000n, 610n, 0n);

    expect(remainingTicks(unclaimedUsage, 40n)).toBe(9);
  });

  it("totalClaimed 變動不影響剩餘格數", () => {
    const beforeClaim = channel(1_000n, 600n, 0n);
    const afterClaim = channel(1_000n, 600n, 600n);

    expect(remainingTicks(beforeClaim, 40n)).toBe(10);
    expect(remainingTicks(afterClaim, 40n)).toBe(10);
  });

  it("已消耗金額大於 balance 時不回傳負格數", () => {
    const inconsistent = channel(100n, 101n, 0n);

    expect(remainingTicks(inconsistent, 40n)).toBe(0);
  });
});

describe("needsDepositTopUp", () => {
  it("可服務餘額剛好等於門檻時不補押金", () => {
    expect(needsDepositTopUp(channel(5_040n, 40n, 0n), 5_000n)).toBe(false);
  });

  it("可服務餘額低於門檻 1 atomic 時補押金", () => {
    expect(needsDepositTopUp(channel(5_039n, 40n, 0n), 5_000n)).toBe(true);
  });

  it("以已提供服務而非 totalClaimed 計算餘額", () => {
    expect(needsDepositTopUp(channel(10_000n, 6_000n, 6_000n), 5_000n)).toBe(true);
  });
});

describe("withdrawDeadlineMs", () => {
  it("未申請提領時沒有 deadline", () => {
    expect(withdrawDeadlineMs({ withdrawRequestedAt: 0 }, 900)).toBeNull();
  });

  it("把鏈上的秒級時間戳與延遲換成毫秒 deadline", () => {
    expect(withdrawDeadlineMs({ withdrawRequestedAt: 1_700_000_000 }, 900)).toBe(
      1_700_000_900_000,
    );
  });
});

describe("守門函式的防呆", () => {
  it("價格不可為 0 或負數 —— 否則剩餘格數是無限大", () => {
    expect(() => remainingTicks(channel(100n, 0n, 0n), 0n)).toThrow(RangeError);
    expect(() => remainingTicks(channel(100n, 0n, 0n), -1n)).toThrow(RangeError);
  });

  it("補款門檻不可為負數", () => {
    expect(() => needsDepositTopUp(channel(100n, 0n, 0n), -1n)).toThrow(RangeError);
  });
});

describe("parseChannelAmounts —— facilitator 回來的數字要先驗過", () => {
  it("三個欄位齊全且都是十進位整數字串時才通過", () => {
    expect(parseChannelAmounts({
      balance: "50000",
      chargedCumulativeAmount: "40",
      totalClaimed: "0",
    })).toEqual({ balance: "50000", chargedCumulativeAmount: "40", totalClaimed: "0" });
  });

  it("欄位殘缺、型別不對或不是數字字串時一律回 null,不猜也不補 0", () => {
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
