import type { Registry } from "./registry.js";
import { upsertSession } from "./sessions.js";
import { extractPayer } from "./payer.js";
import { logger } from "../shared/logger.js";

export type SettleHookDeps = Readonly<{
  registry: Registry;
  creditMs: number;
  priceAtomic: bigint;
}>;

type HookContext = {
  paymentPayload: { payload?: unknown };
  result: { transaction: string; payer?: string };
  transportContext?: { request?: { adapter?: { getHeader(name: string): string | undefined } } };
};

/**
 * session 的建立與延長的唯一入口。
 * 放在 onAfterSettle 而非 Express handler,因為 settle 位於回應的關鍵路徑上 ——
 * 在 handler 內計算 paidUntil 會被結算延遲侵蝕(spec §2.5)。
 */
export function createSettleHook(deps: SettleHookDeps) {
  return async function onAfterSettle(ctx: HookContext): Promise<void> {
    const sessionId = ctx.transportContext?.request?.adapter?.getHeader("X-Drip-Session");
    if (!sessionId) {
      logger.error("hook", "請求未帶 X-Drip-Session,無法建立 session");
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
    logger.info(
      "hook",
      `session ${sessionId.slice(0, 4)} · tick #${result.session.tickCount} · tx ${ctx.result.transaction.slice(0, 10)}`,
    );
  };
}
