import { describe, it, expect } from "vitest";
import { createSseParser } from "../src/agent/sse.js";

describe("createSseParser", () => {
  it("解析單一完整 frame", () => {
    const parse = createSseParser();
    expect(parse("event: token\ndata: hello\n\n")).toEqual([
      { event: "token", data: "hello" },
    ]);
  });

  it("一個 chunk 含多個 frame", () => {
    const parse = createSseParser();
    const frames = parse("event: token\ndata: a\n\nevent: token\ndata: b\n\n");
    expect(frames).toHaveLength(2);
    expect(frames[1]).toEqual({ event: "token", data: "b" });
  });

  it("frame 被切在兩個 chunk 之間時,先緩衝再還原", () => {
    const parse = createSseParser();
    expect(parse("event: token\ndata: hel")).toEqual([]);
    expect(parse("lo\n\n")).toEqual([{ event: "token", data: "hello" }]);
  });

  it("frame 跨三個 chunk", () => {
    const parse = createSseParser();
    expect(parse("event: cre")).toEqual([]);
    expect(parse("dit\ndata: {\"remainingMs\":")).toEqual([]);
    expect(parse("1200}\n\n")).toEqual([
      { event: "credit", data: '{"remainingMs":1200}' },
    ]);
  });

  it("分隔符本身被切開(\\n\\n 跨 chunk)", () => {
    const parse = createSseParser();
    expect(parse("event: token\ndata: x\n")).toEqual([]);
    expect(parse("\n")).toEqual([{ event: "token", data: "x" }]);
  });

  it("多行 data 以換行接合", () => {
    const parse = createSseParser();
    expect(parse("event: token\ndata: line1\ndata: line2\n\n")).toEqual([
      { event: "token", data: "line1\nline2" },
    ]);
  });

  it("忽略註解行與空白 frame", () => {
    const parse = createSseParser();
    expect(parse(": keep-alive\n\n")).toEqual([]);
  });

  it("未指定 event 時預設為 message", () => {
    const parse = createSseParser();
    expect(parse("data: bare\n\n")).toEqual([{ event: "message", data: "bare" }]);
  });

  it("欄位值沒有前導空格", () => {
    const parse = createSseParser();
    expect(parse("event:token\ndata:hello\n\n")).toEqual([
      { event: "token", data: "hello" },
    ]);
  });

  it("無冒號的行被忽略", () => {
    const parse = createSseParser();
    expect(parse("event: token\ninvalidline\ndata: test\n\n")).toEqual([
      { event: "token", data: "test" },
    ]);
  });
});
