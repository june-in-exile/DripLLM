import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import type {
  BatchSettlementChannelManager,
  Channel,
} from "@x402/evm/batch-settlement/server";
import {
  prioritizeWithdrawalPending,
  reportWithdrawDeadlines,
  startClaimJob,
} from "../src/server/claimJob.js";
import { loadConfig, type AppConfig } from "../src/config.js";

function channel(id: string, withdrawRequestedAt: number, lastRequestTimestamp: number): Channel {
  return {
    channelId: id,
    channelConfig: {} as Channel["channelConfig"],
    chargedCumulativeAmount: "40",
    signedMaxClaimable: "40",
    signature: "0x",
    balance: "50000",
    totalClaimed: "0",
    withdrawRequestedAt,
    refundNonce: 0,
    lastRequestTimestamp,
  };
}

function testConfig(overrides: Record<string, string> = {}): AppConfig {
  return loadConfig({
    FACILITATOR_URL: "http://localhost:8080",
    FACILITATOR_PRIVATE_KEY: "0x" + "f".repeat(64),
    LLM_PROVIDER_ADDRESS: "0x1234567890123456789012345678901234567890",
    AGENT_PRIVATE_KEY: "0x" + "a".repeat(64),
    ...overrides,
  });
}

type ManagerCalls = {
  start: unknown[];
  claim: { selectClaimChannels?: (c: Channel[]) => Channel[] }[];
  stop: unknown[];
  claimAndSettle: unknown[];
  settle: unknown[];
};

type FlushOutcome = Awaited<ReturnType<BatchSettlementChannelManager["claimAndSettle"]>>;

function fakeManager(
  pending: Channel[] = [],
  flush: () => Promise<FlushOutcome> = async () => ({ claims: [] }),
) {
  const calls: ManagerCalls = { start: [], claim: [], stop: [], claimAndSettle: [], settle: [] };
  const manager = {
    start: (cfg: unknown) => calls.start.push(cfg),
    getWithdrawalPendingSessions: async () => pending,
    claim: async (opts: ManagerCalls["claim"][number]) => {
      calls.claim.push(opts);
      return [];
    },
    claimAndSettle: async (opts: unknown) => {
      calls.claimAndSettle.push(opts);
      return flush();
    },
    settle: async () => {
      calls.settle.push(true);
      return { transaction: "0xlatesettle" };
    },
    stop: async (opts: unknown) => {
      calls.stop.push(opts);
    },
  };
  return { manager: manager as unknown as BatchSettlementChannelManager, calls };
}

describe("prioritizeWithdrawalPending", () => {
  it("claims withdrawing channels first, keeping oldest-request-first within each group", () => {
    const active = channel("active", 0, 10);
    const pendingNew = channel("pending-new", 200, 30);
    const pendingOld = channel("pending-old", 100, 20);

    expect(prioritizeWithdrawalPending([active, pendingNew, pendingOld]).map((c) => c.channelId))
      .toEqual(["pending-old", "pending-new", "active"]);
  });

  it("doesn't mutate the caller's array", () => {
    const original = [channel("active", 0, 1), channel("pending", 100, 2)];
    prioritizeWithdrawalPending(original);
    expect(original.map((c) => c.channelId)).toEqual(["active", "pending"]);
  });
});

describe("reportWithdrawDeadlines", () => {
  let out: string[];
  let err: string[];

  beforeEach(() => {
    out = [];
    err = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => (out.push(String(c)), true));
    vi.spyOn(process.stderr, "write").mockImplementation((c) => (err.push(String(c)), true));
  });

  afterEach(() => vi.restoreAllMocks());

  it("stays completely silent for channels with no withdrawal request", () => {
    reportWithdrawDeadlines([channel("0xquiet", 0, 0)], 900, 1_700_000_000_000);
    expect(out.join("") + err.join("")).toBe("");
  });

  it("warns with the remaining seconds while a withdrawal is in progress", () => {
    // Requested at t=1_700_000_000s, delay 900s ⇒ deadline is t+900s
    reportWithdrawDeadlines([channel("0xsoon", 1_700_000_000, 0)], 900, 1_700_000_600_000);
    expect(out.join("")).toContain("300s");
  });

  it("escalates to error once the deadline has passed — that revenue may truly be unrecoverable (spec §9)", () => {
    reportWithdrawDeadlines([channel("0xlate", 1_700_000_000, 0)], 900, 1_700_001_000_000);
    expect(err.join("")).toContain("withdrawal deadline passed");
  });
});

describe("startClaimJob", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("passes the §5.2 interval and batch cap to the manager, and lets withdrawal requests jump the queue", () => {
    const config = testConfig();
    const { manager, calls } = fakeManager();
    startClaimJob(manager, config);

    expect(calls.start).toHaveLength(1);
    expect(calls.start[0]).toMatchObject({
      claimIntervalSecs: config.claimIntervalSecs,
      settleIntervalSecs: config.settleIntervalSecs,
      maxClaimsPerBatch: config.maxClaimsPerBatch,
      selectClaimChannels: prioritizeWithdrawalPending,
    });
  });

  it("only includes channels idle longer than REFUND_IDLE_SECS in refunds", () => {
    const config = testConfig({ REFUND_IDLE_SECS: "120" });
    const { manager, calls } = fakeManager();
    startClaimJob(manager, config);

    const started = calls.start[0] as {
      selectRefundChannels: (c: Channel[], ctx: { now: number }) => Channel[];
      shouldSettle: (ctx: { pendingSettle: boolean }) => boolean;
    };
    const now = 1_700_000_000_000;
    const idle = channel("idle", 0, now - 200_000);
    const busy = channel("busy", 0, now - 1_000);

    expect(started.selectRefundChannels([idle, busy], { now }).map((c) => c.channelId))
      .toEqual(["idle"]);
    expect(started.shouldSettle({ pendingSettle: false })).toBe(false);
    expect(started.shouldSettle({ pendingSettle: true })).toBe(true);
  });

  it("claims immediately when polling finds a withdrawal request, picking only withdrawing channels", async () => {
    const config = testConfig({ WITHDRAW_POLL_MS: "1000" });
    const pending = channel("0xPending", 1_700_000_000, 0);
    const { manager, calls } = fakeManager([pending]);
    startClaimJob(manager, config);

    await vi.advanceTimersByTimeAsync(config.withdrawPollMs);

    expect(calls.claim).toHaveLength(1);
    const selector = calls.claim[0]?.selectClaimChannels;
    const others = [channel("0xOther", 0, 0), pending];
    // channelIds differing in case must still match — storage and the chain don't guarantee the same casing
    expect(selector?.(others).map((c) => c.channelId)).toEqual(["0xPending"]);
  });

  it("sends no redundant claim transaction when there is no withdrawal request", async () => {
    const config = testConfig({ WITHDRAW_POLL_MS: "1000" });
    const { manager, calls } = fakeManager([]);
    startClaimJob(manager, config);

    await vi.advanceTimersByTimeAsync(config.withdrawPollMs * 3);

    expect(calls.claim).toHaveLength(0);
  });

  it("doesn't refund idle channels whose deposit is used up — a zero refund is rejected by the contract with ZeroRefund", () => {
    const config = testConfig({ REFUND_IDLE_SECS: "120" });
    const { manager, calls } = fakeManager();
    startClaimJob(manager, config);

    const started = calls.start[0] as {
      selectRefundChannels: (c: Channel[], ctx: { now: number }) => Channel[];
    };
    const now = 1_700_000_000_000;
    const drained = { ...channel("drained", 0, now - 200_000), balance: "11720", chargedCumulativeAmount: "11720" };
    const leftover = { ...channel("leftover", 0, now - 200_000), balance: "11720", chargedCumulativeAmount: "11680" };

    expect(started.selectRefundChannels([drained, leftover], { now }).map((c) => c.channelId))
      .toEqual(["leftover"]);
  });

  it("stop halts polling and flushes unclaimed vouchers itself", async () => {
    const config = testConfig({ WITHDRAW_POLL_MS: "1000" });
    const pending = channel("0xPending", 1_700_000_000, 0);
    const { manager, calls } = fakeManager([pending]);
    const job = startClaimJob(manager, config);

    await job.stop({ flush: true });
    await vi.advanceTimersByTimeAsync(config.withdrawPollMs * 3);

    // manager.stop({ flush }) doesn't trigger onClaim/onSettle, so the job does the flush itself in order to log
    expect(calls.stop).toEqual([undefined]);
    expect(calls.claimAndSettle).toEqual([
      { maxClaimsPerBatch: config.maxClaimsPerBatch, selectClaimChannels: prioritizeWithdrawalPending },
    ]);
    expect(calls.claim).toHaveLength(0);
  });

  it("doesn't settle when stop is called without flush", async () => {
    const { manager, calls } = fakeManager();
    const job = startClaimJob(manager, testConfig());

    await job.stop();

    expect(calls.claimAndSettle).toHaveLength(0);
  });
});

describe("startClaimJob shutdown settlement logs", () => {
  let out: string[];

  beforeEach(() => {
    out = [];
    vi.spyOn(process.stdout, "write").mockImplementation((c) => (out.push(String(c)), true));
  });

  afterEach(() => vi.restoreAllMocks());

  it("prints the claim and settle transactions on success", async () => {
    const { manager } = fakeManager([], async () => ({
      claims: [{ vouchers: 1, transaction: "0xclaim" }],
      settle: { transaction: "0xsettle" },
    }));
    const job = startClaimJob(manager, testConfig());

    await job.stop({ flush: true });

    const log = out.join("");
    expect(log).toContain("[claim] · 1 voucher · tx 0xclaim");
    expect(log).toContain("[settle] · tx 0xsettle");
  });

  it("says so explicitly instead of staying silent when there is nothing to claim or settle", async () => {
    const { manager, calls } = fakeManager();
    const job = startClaimJob(manager, testConfig());

    await job.stop({ flush: true });

    expect(out.join("")).toContain("nothing pending settlement");
    expect(calls.settle).toHaveLength(0);
  });

  it("still settles at shutdown when a scheduled claim ran but the settle cycle hasn't arrived yet", async () => {
    const { manager, calls } = fakeManager();
    const job = startClaimJob(manager, testConfig());
    const started = calls.start[0] as {
      onClaim: (r: { vouchers: number; transaction: string }) => void;
    };

    // The 60s claim already took the voucher, so flush's claimAndSettle makes no new claim and therefore won't settle
    started.onClaim({ vouchers: 1, transaction: "0xperiodic" });
    await job.stop({ flush: true });

    expect(calls.settle).toHaveLength(1);
    expect(out.join("")).toContain("[settle] · tx 0xlatesettle");
  });

  it("counts withdrawal-priority claims as pending settle too, and settles them at shutdown", async () => {
    vi.useFakeTimers();
    const config = testConfig({ WITHDRAW_POLL_MS: "1000" });
    const pending = channel("0xPending", 1_700_000_000, 0);
    const { manager, calls } = fakeManager([pending]);
    (manager as unknown as { claim: () => Promise<unknown[]> }).claim = async () => [
      { vouchers: 2, transaction: "0xwithdrawclaim" },
    ];
    const job = startClaimJob(manager, config);

    await vi.advanceTimersByTimeAsync(config.withdrawPollMs);
    await job.stop({ flush: true });
    vi.useRealTimers();

    expect(out.join("")).toContain("[claim] · 2 voucher · tx 0xwithdrawclaim");
    expect(calls.settle).toHaveLength(1);
  });

  it("doesn't settle twice at shutdown if the settle cycle already settled", async () => {
    const { manager, calls } = fakeManager();
    const job = startClaimJob(manager, testConfig());
    const started = calls.start[0] as {
      onClaim: (r: { vouchers: number; transaction: string }) => void;
      onSettle: (r: { transaction: string }) => void;
    };

    started.onClaim({ vouchers: 1, transaction: "0xperiodic" });
    started.onSettle({ transaction: "0xperiodicsettle" });
    await job.stop({ flush: true });

    expect(calls.settle).toHaveLength(0);
  });

  it("propagates settlement failure upward, leaving main to print 'shutdown settlement failed'", async () => {
    const { manager } = fakeManager([], async () => {
      throw new Error("facilitator down");
    });
    const job = startClaimJob(manager, testConfig());

    await expect(job.stop({ flush: true })).rejects.toThrow("facilitator down");
  });
});
