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
};

function fakeManager(pending: Channel[] = []) {
  const calls: ManagerCalls = { start: [], claim: [], stop: [] };
  const manager = {
    start: (cfg: unknown) => calls.start.push(cfg),
    getWithdrawalPendingSessions: async () => pending,
    claim: async (opts: ManagerCalls["claim"][number]) => {
      calls.claim.push(opts);
      return [];
    },
    stop: async (opts: unknown) => {
      calls.stop.push(opts);
    },
  };
  return { manager: manager as unknown as BatchSettlementChannelManager, calls };
}

describe("prioritizeWithdrawalPending", () => {
  it("提領中的 channel 先 claim,同組內維持最舊請求優先", () => {
    const active = channel("active", 0, 10);
    const pendingNew = channel("pending-new", 200, 30);
    const pendingOld = channel("pending-old", 100, 20);

    expect(prioritizeWithdrawalPending([active, pendingNew, pendingOld]).map((c) => c.channelId))
      .toEqual(["pending-old", "pending-new", "active"]);
  });

  it("不改動呼叫端傳入的陣列", () => {
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

  it("沒申請提領的 channel 完全不出聲", () => {
    reportWithdrawDeadlines([channel("0xquiet", 0, 0)], 900, 1_700_000_000_000);
    expect(out.join("") + err.join("")).toBe("");
  });

  it("提領進行中時警告剩餘秒數", () => {
    // 申請於 t=1_700_000_000s,延遲 900s ⇒ 期限為 t+900s
    reportWithdrawDeadlines([channel("0xsoon", 1_700_000_000, 0)], 900, 1_700_000_600_000);
    expect(out.join("")).toContain("300s");
  });

  it("期限已過時升級為 error —— 那段收入可能真的收不回(spec §9)", () => {
    reportWithdrawDeadlines([channel("0xlate", 1_700_000_000, 0)], 900, 1_700_001_000_000);
    expect(err.join("")).toContain("提領期限已過");
  });
});

describe("startClaimJob", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("把 §5.2 的週期與批次上限交給 manager,並讓提領申請插隊", () => {
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

  it("只把閒置超過 REFUND_IDLE_SECS 的 channel 納入退款", () => {
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

  it("輪詢到提領申請時立即 claim,且只挑提領中的 channel", async () => {
    const config = testConfig({ WITHDRAW_POLL_MS: "1000" });
    const pending = channel("0xPending", 1_700_000_000, 0);
    const { manager, calls } = fakeManager([pending]);
    startClaimJob(manager, config);

    await vi.advanceTimersByTimeAsync(config.withdrawPollMs);

    expect(calls.claim).toHaveLength(1);
    const selector = calls.claim[0]?.selectClaimChannels;
    const others = [channel("0xOther", 0, 0), pending];
    // 大小寫不同的 channelId 也要對得上 —— storage 與鏈上的寫法不保證一致
    expect(selector?.(others).map((c) => c.channelId)).toEqual(["0xPending"]);
  });

  it("沒有提領申請時不發出多餘的 claim 交易", async () => {
    const config = testConfig({ WITHDRAW_POLL_MS: "1000" });
    const { manager, calls } = fakeManager([]);
    startClaimJob(manager, config);

    await vi.advanceTimersByTimeAsync(config.withdrawPollMs * 3);

    expect(calls.claim).toHaveLength(0);
  });

  it("stop 會停掉輪詢並要求 manager 沖出未請款的 voucher", async () => {
    const config = testConfig({ WITHDRAW_POLL_MS: "1000" });
    const pending = channel("0xPending", 1_700_000_000, 0);
    const { manager, calls } = fakeManager([pending]);
    const job = startClaimJob(manager, config);

    await job.stop({ flush: true });
    await vi.advanceTimersByTimeAsync(config.withdrawPollMs * 3);

    expect(calls.stop).toEqual([{ flush: true }]);
    expect(calls.claim).toHaveLength(0);
  });
});
