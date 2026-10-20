import { describe, it, expect } from "vitest";
import { extractPayer, PayerUnknownError } from "../src/server/payer.js";

const FROM = "0xaaaa000000000000000000000000000000000001";
const SETTLE = "0xbbbb000000000000000000000000000000000002";

const payload = (from?: string) => ({
  signature: "0xsig",
  authorization: from !== undefined ? { from, to: "0xto", value: "1000" } : {},
});

describe("extractPayer", () => {
  it("prefers authorization.from", () => {
    expect(extractPayer(payload(FROM), SETTLE)).toBe(FROM);
  });

  it("falls back to result.payer when authorization.from is absent", () => {
    expect(extractPayer(payload(undefined), SETTLE)).toBe(SETTLE);
  });

  it("falls back to result.payer when authorization.from is an empty string", () => {
    expect(extractPayer(payload(""), SETTLE)).toBe(SETTLE);
  });

  it("throws when both are empty, never returning undefined", () => {
    expect(() => extractPayer(payload(undefined), undefined)).toThrow(PayerUnknownError);
  });

  it("throws instead of silently passing when the payload isn't an object", () => {
    expect(() => extractPayer(null, undefined)).toThrow(PayerUnknownError);
    expect(() => extractPayer("nope", undefined)).toThrow(PayerUnknownError);
  });

  it("an empty string isn't a valid address", () => {
    expect(() => extractPayer(payload(""), "")).toThrow(PayerUnknownError);
  });

  it("always normalizes addresses to lowercase so casing can't cause false mismatches", () => {
    expect(extractPayer(payload(FROM.toUpperCase()), undefined)).toBe(FROM.toLowerCase());
  });

  it("batch-settlement takes the payer from channelConfig.payer", () => {
    expect(
      extractPayer({ type: "voucher", channelConfig: { payer: FROM.toUpperCase() } }),
    ).toBe(FROM.toLowerCase());
  });
});
