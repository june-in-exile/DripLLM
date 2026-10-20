import { describe, it, expect } from "vitest";
import { createSseParser } from "../src/agent/sse.js";

describe("createSseParser", () => {
  it("parses a single complete frame", () => {
    const parse = createSseParser();
    expect(parse("event: token\ndata: hello\n\n")).toEqual([
      { event: "token", data: "hello" },
    ]);
  });

  it("one chunk containing multiple frames", () => {
    const parse = createSseParser();
    const frames = parse("event: token\ndata: a\n\nevent: token\ndata: b\n\n");
    expect(frames).toHaveLength(2);
    expect(frames[1]).toEqual({ event: "token", data: "b" });
  });

  it("a frame split across two chunks is buffered and then reassembled", () => {
    const parse = createSseParser();
    expect(parse("event: token\ndata: hel")).toEqual([]);
    expect(parse("lo\n\n")).toEqual([{ event: "token", data: "hello" }]);
  });

  it("a frame spanning three chunks", () => {
    const parse = createSseParser();
    expect(parse("event: cre")).toEqual([]);
    expect(parse("dit\ndata: {\"remainingMs\":")).toEqual([]);
    expect(parse("1200}\n\n")).toEqual([
      { event: "credit", data: '{"remainingMs":1200}' },
    ]);
  });

  it("the separator itself is split (\\n\\n across chunks)", () => {
    const parse = createSseParser();
    expect(parse("event: token\ndata: x\n")).toEqual([]);
    expect(parse("\n")).toEqual([{ event: "token", data: "x" }]);
  });

  it("multi-line data is joined with newlines", () => {
    const parse = createSseParser();
    expect(parse("event: token\ndata: line1\ndata: line2\n\n")).toEqual([
      { event: "token", data: "line1\nline2" },
    ]);
  });

  it("ignores comment lines and empty frames", () => {
    const parse = createSseParser();
    expect(parse(": keep-alive\n\n")).toEqual([]);
  });

  it("defaults to message when no event is given", () => {
    const parse = createSseParser();
    expect(parse("data: bare\n\n")).toEqual([{ event: "message", data: "bare" }]);
  });

  it("field values have no leading space", () => {
    const parse = createSseParser();
    expect(parse("event:token\ndata:hello\n\n")).toEqual([
      { event: "token", data: "hello" },
    ]);
  });

  it("lines without a colon are ignored", () => {
    const parse = createSseParser();
    expect(parse("event: token\ninvalidline\ndata: test\n\n")).toEqual([
      { event: "token", data: "test" },
    ]);
  });
});
