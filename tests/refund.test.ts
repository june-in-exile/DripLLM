import { describe, expect, it } from "vitest";
import { isNothingToRefund } from "../src/agent/refund.js";

describe("isNothingToRefund", () => {
  it("deposit fully used -- not a failure, nothing is locked", () => {
    const e = new Error(
      "Refund failed: channel has no remaining balance (balance=11720, chargedCumulativeAmount=11720)",
    );
    expect(isNothingToRefund(e)).toBe(true);
  });

  it("other refund errors are still real failures", () => {
    expect(isNothingToRefund(new Error("Refund failed: facilitator unreachable"))).toBe(false);
  });

  it("non-Error thrown values are not misjudged", () => {
    expect(isNothingToRefund("channel has no remaining balance")).toBe(false);
    expect(isNothingToRefund(undefined)).toBe(false);
  });
});
