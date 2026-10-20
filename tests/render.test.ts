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
  it("shows tx when there is a tx hash, otherwise labels it voucher", () => {
    renderTick(1, "0xabcdef0123456789", 40n);
    renderTick(2, undefined, 80n);
    expect(out.join("")).toContain("tx 0xabcdef0123");
    expect(out.join("")).toContain("voucher");
  });

  it("with channel state, shows deposit, signed cap and consumed together (spec §10.4)", () => {
    renderTick(3, undefined, 120n, { balance: "50000", ceiling: "120", cumulative: "120" });
    const line = out.join("");
    expect(line).toContain("bal");
    expect(line).toContain("cap");
    expect(line).toContain("sum");
  });

  it("without channel state, emits no partial fields", () => {
    renderTick(1, undefined, 40n, {});
    expect(out.join("")).not.toContain("bal");
  });
});

describe("renderToken", () => {
  it("writes verbatim, no newline added", () => {
    renderToken("hello");
    expect(out.join("")).toBe("hello");
  });
});

describe("renderCredit", () => {
  it("speaks only during the grace period; stays quiet otherwise so it doesn't drown the token stream", () => {
    renderCredit(500, false);
    expect(out.join("") + err.join("")).toBe("");

    renderCredit(-20, true);
    expect(out.join("")).toContain("grace period");
  });
});

describe("renderStopPaying", () => {
  it("manual stop and hitting the spend cap give different messages", () => {
    renderStopPaying("manual", 120n);
    renderStopPaying("cap", 50000n);
    const text = out.join("");
    expect(text).toContain("stopped paying, connection held open");
    expect(text).toContain("spend cap");
  });
});

describe("renderCut", () => {
  it("cut summary goes to stderr with tick count and total spent", () => {
    renderCut(12, 480n);
    expect(err.join("")).toContain("12");
    expect(err.join("")).toContain("stream cut by server");
  });
});
