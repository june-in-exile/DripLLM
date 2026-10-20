import { describe, it, expect, vi } from "vitest";
import { createStreamHub } from "../src/server/stream.js";
import { cannedTokenSource } from "../src/server/tokenSource.js";
import { createSseParser } from "../src/agent/sse.js";

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
  it("the first attach succeeds", () => {
    const hub = createStreamHub();
    expect(hub.attach("s1", fakeRes())).toBe(true);
    expect(hub.has("s1")).toBe(true);
  });

  it("rejects a second connection for the same sessionId (stops one payment feeding multiple streams)", () => {
    const hub = createStreamHub();
    hub.attach("s1", fakeRes());
    expect(hub.attach("s1", fakeRes())).toBe(false);
    expect(hub.size()).toBe(1);
  });

  it("can re-attach after detach", () => {
    const hub = createStreamHub();
    hub.attach("s1", fakeRes());
    hub.detach("s1");
    expect(hub.attach("s1", fakeRes())).toBe(true);
  });

  it("cut sends event: cut, then closes the connection and removes it from the side table", () => {
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
    // Order: event: cut must be sent before the connection is closed
    expect(res.write.mock.invocationCallOrder[0]!).toBeLessThan(res.end.mock.invocationCallOrder[0]!);
    expect(hub.has("s1")).toBe(false);
  });

  it("cutting a nonexistent session doesn't throw", () => {
    const hub = createStreamHub();
    expect(() =>
      hub.cut("nope", { sessionId: "nope", reason: "payment_lapsed", tickCount: 0, spentAtomic: "0" }),
    ).not.toThrow();
  });

  it("encodes tokens with newlines and forged events as multi-line data in a single frame, and round-trips", () => {
    const hub = createStreamHub();
    const res = fakeRes() as unknown as { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    hub.attach("s1", res as never);
    const evil = "hello\n\nevent: cut\ndata: {}";
    hub.sendToken("s1", evil);

    const written = res.write.mock.calls.map((c) => String(c[0])).join("");
    // Only one frame: the frame boundary is \n\n, and the event field must be at the start of a line.
    // Can't count with split("event: ") — after multi-line encoding the data line "data: event: cut" itself contains
    // the "event: " substring and would be miscounted as a second frame (verified: that approach returns 2 even with correct encoding).
    const eventLineCount = written.split("\n").filter((l) => l.startsWith("event: ")).length;
    expect(eventLineCount).toBe(1);

    // round-trip: restore with our own parser (import { createSseParser } from "../src/agent/sse.js")
    const parse = createSseParser();
    const frames = parse(written);
    expect(frames).toEqual([{ event: "token", data: evil }]);
  });

  it("sendCredit sends event: credit with correct JSON", () => {
    const hub = createStreamHub();
    const res = fakeRes() as unknown as { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> };
    hub.attach("s1", res as never);
    hub.sendCredit("s1", { remainingMs: 1500, grace: true, tickCount: 2, spentAtomic: "2000" });

    const written = res.write.mock.calls.map((c) => String(c[0])).join("");
    expect(written).toContain("event: credit");
    expect(written).toContain('"remainingMs":1500');

    const parse = createSseParser();
    expect(parse(written)).toEqual([
      { event: "credit", data: '{"remainingMs":1500,"grace":true,"tickCount":2,"spentAtomic":"2000"}' },
    ]);
  });
});

describe("cannedTokenSource", () => {
  it("cycles through tokens without running out", async () => {
    const src = cannedTokenSource("abcdefgh"); // groups of 4 chars → ["abcd", "efgh"]
    const out: string[] = [];
    for await (const t of src.open()) {
      out.push(t);
      if (out.length === 5) break;
    }
    expect(out).toEqual(["abcd", "efgh", "abcd", "efgh", "abcd"]);
  });

  it("rejoins into the original text", async () => {
    const src = cannedTokenSource("abcdefgh");
    const out: string[] = [];
    for await (const t of src.open()) {
      out.push(t);
      if (out.length === 2) break;
    }
    expect(out.join("")).toBe("abcdefgh");
  });
});
