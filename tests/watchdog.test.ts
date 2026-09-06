import { describe, it, expect, vi } from "vitest";
import { createWatchdog } from "../src/server/watchdog.js";
import { createRegistry } from "../src/server/registry.js";
import { createStreamHub } from "../src/server/stream.js";
import { upsertSession } from "../src/server/sessions.js";

const PAYER = "0xaaaa000000000000000000000000000000000001";

function setup(nowMs = 1000, creditMs = 5000) {
  const registry = createRegistry();
  const hub = createStreamHub();
  const r = upsertSession(registry.getStore(), "s1", PAYER, nowMs, creditMs, 1000n, "0xtx");
  if (!r.ok) throw new Error("seed failed");
  registry.setStore(r.store);
  const res = { write: vi.fn(), end: vi.fn() } as never;
  hub.attach("s1", res);
  const watchdog = createWatchdog({ registry, hub, graceMs: 2000 });
  return { registry, hub, watchdog, res: res as unknown as { write: ReturnType<typeof vi.fn>; end: ReturnType<typeof vi.fn> } };
}

describe("watchdog sweep —— 寬限期邊界", () => {
  it("寬限期最後 1ms 不剪", () => {
    const { watchdog, hub } = setup();
    watchdog.sweep(8000);
    expect(hub.has("s1")).toBe(true);
  });

  it("超過寬限 1ms 即剪", () => {
    const { watchdog, hub } = setup();
    watchdog.sweep(8001);
    expect(hub.has("s1")).toBe(false);
  });
});

describe("watchdog sweep —— 剪線副作用", () => {
  it("cut payload 帶正確的 tickCount 與 spentAtomic(須在移除前取值)", () => {
    const { registry, watchdog, res } = setup();
    const second = upsertSession(registry.getStore(), "s1", PAYER, 2000, 5000, 1000n, "0xtx2");
    if (!second.ok) throw new Error("extend failed");
    registry.setStore(second.store);

    watchdog.sweep(20000);

    const written = res.write.mock.calls.map((c) => String(c[0])).join("");
    expect(written).toContain("event: cut");
    expect(written).toContain('"tickCount":2');
    expect(written).toContain('"spentAtomic":"2000"');
    expect(written).not.toContain("undefined");
  });

  it("剪線後 session 自帳本移除", () => {
    const { registry, watchdog } = setup();
    watchdog.sweep(9000);
    expect(registry.getStore().has("s1")).toBe(false);
  });

  it("剪線後 id 進入 tombstone", () => {
    const { registry, watchdog } = setup();
    watchdog.sweep(9000);
    expect(registry.isCut("s1", 9000, 60000)).toBe(true);
  });

  it("連線被關閉", () => {
    const { watchdog, res } = setup();
    watchdog.sweep(9000);
    expect(res.end).toHaveBeenCalled();
  });

  it("重複 sweep 不重複剪線(冪等)", () => {
    const { watchdog, res } = setup();
    watchdog.sweep(9000);
    watchdog.sweep(9500);
    expect(res.end).toHaveBeenCalledTimes(1);
  });
});

describe("watchdog start/stop", () => {
  it("stop 後不再觸發 sweep", () => {
    vi.useFakeTimers();
    const { watchdog, hub } = setup();
    watchdog.start(250);
    watchdog.stop();
    vi.advanceTimersByTime(60000);
    expect(hub.has("s1")).toBe(true);
    vi.useRealTimers();
  });
});
