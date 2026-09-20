import type { Registry } from "./registry.js";
import { upsertSession } from "./sessions.js";
import { extractPayer } from "./payer.js";
import {
  canServe,
  needsDepositTopUp,
  parseChannelAmounts,
  remainingTicks,
} from "./channels.js";
import { logger } from "../shared/logger.js";

export type SettleHookDeps = Readonly<{
  registry: Registry;
  creditMs: number;
  priceAtomic: bigint;
  depositTopupAtomic: bigint;
}>;

type HookContext = {
  paymentPayload: { payload?: unknown };
  result: { transaction: string; payer?: string; extra?: unknown };
  transportContext?: { request?: { adapter?: { getHeader(name: string): string | undefined } } };
};

function readChannelState(extra: unknown): unknown {
  if (typeof extra !== "object" || extra === null) return undefined;
  return (extra as { channelState?: unknown }).channelState;
}

/**
 * 押金守門(spec §2.5.1)。協議只保證 voucher 不超過買方簽的上限,不保證押金蓋得住,
 * 所以每格結算後都要回頭確認押金還撐得住下一格,撐不住就告警 ——
 * 下一格的 /tick 會被擋在 402,paidUntil 不再延長,watchdog 自然剪線(spec §7)。
 *
 * @returns 可服務格數;channelState 殘缺時回 null(不猜數字)。
 */
function reportChannelHealth(
  sessionId: string,
  extra: unknown,
  deps: SettleHookDeps,
  lowBalance: Set<string>,
): number | null {
  const channel = parseChannelAmounts(readChannelState(extra));
  if (!channel) return null;

  const tag = sessionId.slice(0, 4);
  const ticks = remainingTicks(channel, deps.priceAtomic);
  if (!canServe(channel, deps.priceAtomic)) {
    logger.warn("channel", `session ${tag} 押金不足以支付下一格,下次 /tick 將被拒絕`);
    return ticks;
  }
  // 邊緣觸發。補款金額與警告門檻同量級,逐格判斷會在補款後立刻又低於門檻,
  // 變成每秒一行的噪音 —— 只在跨越門檻的那一格出聲。
  if (needsDepositTopUp(channel, deps.depositTopupAtomic)) {
    if (!lowBalance.has(sessionId)) {
      lowBalance.add(sessionId);
      logger.warn("channel", `session ${tag} 押金餘額偏低,尚可服務 ${ticks} 格`);
    }
  } else {
    lowBalance.delete(sessionId);
  }
  return ticks;
}

/**
 * session 的建立與延長的唯一入口。
 * 放在 onAfterSettle 而非 Express handler,因為 settle 位於回應的關鍵路徑上 ——
 * 在 handler 內計算 paidUntil 會被結算延遲侵蝕(spec §2.5)。
 */
export function createSettleHook(deps: SettleHookDeps) {
  /** 已經為哪些 session 報過「押金偏低」,用來讓警告只在跨越門檻時出現一次。 */
  const lowBalance = new Set<string>();

  return async function onAfterSettle(ctx: HookContext): Promise<void> {
    const sessionId = ctx.transportContext?.request?.adapter?.getHeader("X-Drip-Session");
    if (!sessionId) {
      // 退款走的是同一條 /tick,而它本來就沒有 session —— 不是錯誤。
      logger.info("hook", "結算未帶 X-Drip-Session(退款或探測),不建立 session");
      return;
    }

    // tombstone 已由 /tick handler 在結算前擋下(spec §2.2.1),此處不需再處理。
    const payer = extractPayer(ctx.paymentPayload.payload, ctx.result.payer);
    const result = upsertSession(
      deps.registry.getStore(),
      sessionId,
      payer,
      Date.now(),
      deps.creditMs,
      deps.priceAtomic,
      ctx.result.transaction,
    );

    if (!result.ok) {
      // 無法回 403 —— hook 在 response 定案後才執行。該 session 不再續命,
      // 最終由 watchdog 剪線(spec §7)。
      logger.error("hook", `session ${sessionId.slice(0, 4)} 屬於其他付款者,拒絕延長`);
      return;
    }

    deps.registry.setStore(result.store);
    const ticks = reportChannelHealth(sessionId, ctx.result.extra, deps, lowBalance);
    const settled = ctx.result.transaction ? `tx ${ctx.result.transaction.slice(0, 10)}` : "voucher";
    const budget = ticks === null ? "" : ` · 押金尚可 ${ticks} 格`;
    logger.info(
      "hook",
      `session ${sessionId.slice(0, 4)} · tick #${result.session.tickCount} · ${settled}${budget}`,
    );
  };
}
