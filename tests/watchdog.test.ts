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

describe("watchdog sweep — grace period boundary", () => {
  it("doesn't cut in the last 1ms of grace", () => {
    const { watchdog, hub } = setup();
    watchdog.sweep(8000);
    expect(hub.has("s1")).toBe(true);
  });

  it("cuts 1ms past grace", () => {
    const { watchdog, hub } = setup();
    watchdog.sweep(8001);
    expect(hub.has("s1")).toBe(false);
  });
});

describe("watchdog sweep — cut side effects", () => {
  it("cut payload carries correct tickCount and spentAtomic (must be read before removal)", () => {
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

  it("the session is removed from the ledger after a cut", () => {
    const { registry, watchdog } = setup();
    watchdog.sweep(9000);
    expect(registry.getStore().has("s1")).toBe(false);
  });

  it("the id goes into the tombstone after a cut", () => {
    const { registry, watchdog } = setup();
    watchdog.sweep(9000);
    expect(registry.isCut("s1", 9000, 60000)).toBe(true);
  });

  it("the connection is closed", () => {
    const { watchdog, res } = setup();
    watchdog.sweep(9000);
    expect(res.end).toHaveBeenCalled();
  });

  it("repeated sweeps don't cut twice (idempotent)", () => {
    const { watchdog, res } = setup();
    watchdog.sweep(9000);
    watchdog.sweep(9500);
    expect(res.end).toHaveBeenCalledTimes(1);
  });
});

describe("watchdog sweep — cut ordering safeguards (observing intermediate state)", () => {
  it("the session is already out of the ledger when the cut frame is written (remove first, then send cut)", () => {
    const { registry, watchdog, res } = setup();
    // res.write fires synchronously inside hub.cut — checking the ledger here observes the intermediate state "at the moment of cut".
    res.write.mockImplementation(() => {
      expect(registry.getStore().has("s1")).toBe(false);
    });
    watchdog.sweep(9000);
    expect(res.write).toHaveBeenCalled();
  });

  it("the ledger no longer has this session when onCut fires (remove first, then notify)", () => {
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
  it("no more sweeps after stop", () => {
    vi.useFakeTimers();
    const { watchdog, hub } = setup();
    watchdog.start(250);
    watchdog.stop();
    vi.advanceTimersByTime(60000);
    expect(hub.has("s1")).toBe(true);
    vi.useRealTimers();
  });
});

describe("watchdog sweep — server-side demo log", () => {
  function captureStdout(): string[] {
    const out: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => (out.push(String(c)), true));
    return out;
  }

  afterEach(() => vi.restoreAllMocks());

  it("prints the grace warning once when paid time runs out, not again for the same tick", () => {
    const { watchdog } = setup();
    const out = captureStdout();
    watchdog.sweep(5999);
    expect(out.join("")).not.toContain("grace");
    watchdog.sweep(6000);
    watchdog.sweep(6100);
    watchdog.sweep(7000);
    const warns = out.filter((l) => l.includes("grace"));
    expect(warns).toEqual(["[watchdog] ⚠ session s1 · paid time used up, grace period 2000ms\n"]);
  });

  it("warns again when a top-up extends it during grace and it then runs out again", () => {
    const { registry, watchdog } = setup();
    const out = captureStdout();
    watchdog.sweep(6000);
    const extended = upsertSession(registry.getStore(), "s1", PAYER, 6500, 5000, 1000n, "0xtx2");
    if (!extended.ok) throw new Error("extend failed");
    registry.setStore(extended.store);
    watchdog.sweep(6600);
    watchdog.sweep(11500);
    expect(out.filter((l) => l.includes("grace"))).toHaveLength(2);
  });

  it("prints the tick count and total revenue on cut", () => {
    const { watchdog } = setup();
    const out = captureStdout();
    watchdog.sweep(9000);
    expect(out).toContain("[watchdog] ✂ session s1 · stream cut · 1 ticks total · $0.001\n");
  });

  it("prints nothing during steady top-ups (not yet run out)", () => {
    const { watchdog } = setup();
    const out = captureStdout();
    watchdog.sweep(3000);
    watchdog.sweep(5900);
    expect(out).toEqual([]);
  });
});
