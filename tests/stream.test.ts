import { describe, it, expect, vi } from "vitest";
import { createStreamHub } from "../src/server/stream.js";
import { cannedTokenSource } from "../src/server/tokenSource.js";

function fakeRes() {
  return {
    write: vi.fn(),
    end: vi.fn(),
    writeHead: vi.fn(),
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
  } as never;
}

describe("createStreamHub", () => {
  it("attach 第一條連線成功", () => {
    const hub = createStreamHub();
    expect(hub.attach("s1", fakeRes())).toBe(true);
    expect(hub.has("s1")).toBe(true);
  });

  it("同一 sessionId 的第二條連線被拒絕(防止一份付款餵多條流)", () => {
    const hub = createStreamHub();
    hub.attach("s1", fakeRes());
    expect(hub.attach("s1", fakeRes())).toBe(false);
    expect(hub.size()).toBe(1);
  });

  it("detach 後可重新 attach", () => {
    const hub = createStreamHub();
    hub.attach("s1", fakeRes());
    hub.detach("s1");
    expect(hub.attach("s1", fakeRes())).toBe(true);
  });

  it("cut 送出 event: cut 後關閉連線並自副表移除", () => {
    const hub = createStreamHub();
    const res = fakeRes() as unknown as { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    hub.attach("s1", res as never);
    hub.cut("s1", {
      sessionId: "s1",
      reason: "payment_lapsed",
      tickCount: 3,
      spentAtomic: "3000",
    });

    const written = res.write.mock.calls.map((c) => String(c[0])).join("");
    expect(written).toContain("event: cut");
    expect(written).toContain('"tickCount":3');
    expect(written).toContain('"spentAtomic":"3000"');
    expect(res.end).toHaveBeenCalled();
    expect(hub.has("s1")).toBe(false);
  });

  it("cut 不存在的 session 不拋錯", () => {
    const hub = createStreamHub();
    expect(() =>
      hub.cut("nope", { sessionId: "nope", reason: "payment_lapsed", tickCount: 0, spentAtomic: "0" }),
    ).not.toThrow();
  });
});

describe("cannedTokenSource", () => {
  it("循環吐出詞元,不會耗盡", async () => {
    const src = cannedTokenSource("abcdefgh"); // 4 字一組 → ["abcd", "efgh"]
    const out: string[] = [];
    for await (const t of src.open()) {
      out.push(t);
      if (out.length === 5) break;
    }
    expect(out).toEqual(["abcd", "efgh", "abcd", "efgh", "abcd"]);
  });

  it("接合後還原原文", async () => {
    const src = cannedTokenSource("abcdefgh");
    const out: string[] = [];
    for await (const t of src.open()) {
      out.push(t);
      if (out.length === 2) break;
    }
    expect(out.join("")).toBe("abcdefgh");
  });
});
