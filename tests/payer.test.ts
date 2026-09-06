import { describe, it, expect } from "vitest";
import { extractPayer, PayerUnknownError } from "../src/server/payer.js";

const FROM = "0xaaaa000000000000000000000000000000000001";
const SETTLE = "0xbbbb000000000000000000000000000000000002";

const payload = (from?: string) => ({
  signature: "0xsig",
  authorization: from ? { from, to: "0xto", value: "1000" } : {},
});

describe("extractPayer", () => {
  it("優先採用 authorization.from", () => {
    expect(extractPayer(payload(FROM), SETTLE)).toBe(FROM);
  });

  it("authorization.from 缺席時退回 result.payer", () => {
    expect(extractPayer(payload(undefined), SETTLE)).toBe(SETTLE);
  });

  it("兩者皆空時拋錯,絕不回傳 undefined", () => {
    expect(() => extractPayer(payload(undefined), undefined)).toThrow(PayerUnknownError);
  });

  it("payload 非物件時拋錯而非靜默通過", () => {
    expect(() => extractPayer(null, undefined)).toThrow(PayerUnknownError);
    expect(() => extractPayer("nope", undefined)).toThrow(PayerUnknownError);
  });

  it("空字串不算有效地址", () => {
    expect(() => extractPayer(payload(""), "")).toThrow(PayerUnknownError);
  });

  it("地址一律正規化為小寫,避免大小寫造成誤判不符", () => {
    expect(extractPayer(payload(FROM.toUpperCase()), undefined)).toBe(FROM.toLowerCase());
  });
});
