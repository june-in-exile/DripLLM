import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  renderTick,
  renderToken,
  renderCredit,
  renderStopPaying,
  renderCut,
} from "../src/agent/render.js";

let out: string[];
let err: string[];

beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("renderTick", () => {
  it("有交易雜湊時顯示 tx,沒有時標成 voucher", () => {
    renderTick(1, "0xabcdef0123456789", 40n);
    renderTick(2, undefined, 80n);
    expect(out.join("")).toContain("tx 0xabcdef0123");
    expect(out.join("")).toContain("voucher");
  });

  it("帶 channel 狀態時同時顯示押金餘額、已簽上限與累計消耗(spec §10.4)", () => {
    renderTick(3, undefined, 120n, { balance: "50000", ceiling: "120", cumulative: "120" });
    const line = out.join("");
    expect(line).toContain("bal");
    expect(line).toContain("cap");
    expect(line).toContain("sum");
  });

  it("沒有 channel 狀態時不輸出殘缺欄位", () => {
    renderTick(1, undefined, 40n, {});
    expect(out.join("")).not.toContain("bal");
  });
});

describe("renderToken", () => {
  it("原樣寫出,不加換行", () => {
    renderToken("hello");
    expect(out.join("")).toBe("hello");
  });
});

describe("renderCredit", () => {
  it("只在寬限期內出聲,平時保持安靜以免蓋掉 token 串流", () => {
    renderCredit(500, false);
    expect(out.join("") + err.join("")).toBe("");

    renderCredit(-20, true);
    expect(out.join("")).toContain("寬限期");
  });
});

describe("renderStopPaying", () => {
  it("手動停付與撞上花費上限給的是不同訊息", () => {
    renderStopPaying("manual", 120n);
    renderStopPaying("cap", 50000n);
    const text = out.join("");
    expect(text).toContain("已停止付款");
    expect(text).toContain("花費上限");
  });
});

describe("renderCut", () => {
  it("剪線摘要走 stderr,含 tick 數與總花費", () => {
    renderCut(12, 480n);
    expect(err.join("")).toContain("12");
    expect(err.join("")).toContain("串流已被 server 切斷");
  });
});
