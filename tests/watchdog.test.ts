import { describe, it, expect, vi, afterEach } from "vitest";
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
  const watchdog = createWatchdog({ registry, hub, graceMs: 2000, tombstoneTtlMs: 60000 });
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

describe("watchdog sweep —— 剪線順序防線(觀察中間狀態)", () => {
  it("cut frame 寫出時 session 已不在帳本(先移除、後送 cut)", () => {
    const { registry, watchdog, res } = setup();
    // res.write 在 hub.cut 內部同步觸發 —— 在此刻檢查帳本,能觀察「cut 當下」的中間狀態。
    res.write.mockImplementation(() => {
      expect(registry.getStore().has("s1")).toBe(false);
    });
    watchdog.sweep(9000);
    expect(res.write).toHaveBeenCalled();
  });

  it("onCut 觸發時帳本已無此 session(先移除、後通知)", () => {
    const registry = createRegistry();
    const hub = createStreamHub();
    const r = upsertSession(registry.getStore(), "s1", PAYER, 1000, 5000, 1000n, "0xtx");
    if (!r.ok) throw new Error("seed failed");
    registry.setStore(r.store);
    const res = { write: vi.fn(), end: vi.fn() } as never;
    hub.attach("s1", res);
    let presentAtCut = true;
    const watchdog = createWatchdog({
      registry,
      hub,
      graceMs: 2000,
      tombstoneTtlMs: 60000,
      onCut: () => {
        presentAtCut = registry.getStore().has("s1");
      },
    });
    watchdog.sweep(9000);
    expect(presentAtCut).toBe(false);
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

describe("watchdog sweep —— server 端 demo log", () => {
  function captureStdout(): string[] {
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => (out.push(String(c)), true));
    return out;
  }

  afterEach(() => vi.restoreAllMocks());

  it("已付時間用完時印一次寬限警告,同一格不重複印", () => {
    const { watchdog } = setup();
    const out = captureStdout();
    watchdog.sweep(5999);
    expect(out.join("")).not.toContain("寬限");
    watchdog.sweep(6000);
    watchdog.sweep(6100);
    watchdog.sweep(7000);
    const warns = out.filter((l) => l.includes("寬限"));
    expect(warns).toEqual(["[watchdog] ⚠ session s1 · 已付時間用完,寬限 2000ms\n"]);
  });

  it("寬限中被補款延長,再次用完時重新警告", () => {
    const { registry, watchdog } = setup();
    const out = captureStdout();
    watchdog.sweep(6000);
    const extended = upsertSession(registry.getStore(), "s1", PAYER, 6500, 5000, 1000n, "0xtx2");
    if (!extended.ok) throw new Error("extend failed");
    registry.setStore(extended.store);
    watchdog.sweep(6600);
    watchdog.sweep(11500);
    expect(out.filter((l) => l.includes("寬限"))).toHaveLength(2);
  });

  it("剪線時印出格數與總收入", () => {
    const { watchdog } = setup();
    const out = captureStdout();
    watchdog.sweep(9000);
    expect(out).toContain("[watchdog] ✂ session s1 · 切斷串流 · 共 1 格 · $0.001\n");
  });

  it("穩定補款(尚未用完)時完全不印", () => {
    const { watchdog } = setup();
    const out = captureStdout();
    watchdog.sweep(3000);
    watchdog.sweep(5900);
    expect(out).toEqual([]);
  });
});
