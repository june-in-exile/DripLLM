import { z } from "zod";
import type { AppConfig } from "../config.js";
import type { ChannelRequirements, createWallet } from "./wallet.js";

export type PayResult = Readonly<{
  sessionId: string;
  txHash: string | undefined;
  channelBalance?: string;
  signedCeiling?: string;
  chargedCumulative?: string;
}>;

/** The sessionId has been cut and is still in its tombstone period -- the middleware cancelled the payment; nothing was charged. */
export class SessionCutError extends Error {
  constructor() {
    super("This sessionId has been cut; use a new sessionId");
    this.name = "SessionCutError";
  }
}

/**
 * The local channel record is out of sync with the chain (usually because the seller refunded).
 * Dropping the record and retrying once lets recoverChannel rebuild it from the chain.
 */
class StaleChannelError extends Error {
  constructor(readonly accepted: ChannelRequirements) {
    super("Local channel record is stale");
    this.name = "StaleChannelError";
  }
}

/** A 402's payment requirements and rejection reason both live in the PAYMENT-REQUIRED header; the body is an empty object. */
function decodePaymentRequired(res: Response): {
  error: string;
  accepted: ChannelRequirements | undefined;
} {
  const encoded = res.headers.get("payment-required");
  if (!encoded) return { error: "", accepted: undefined };
  try {
    const decoded = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as {
      error?: unknown;
      accepts?: ChannelRequirements[];
    };
    return {
      error: typeof decoded.error === "string" ? decoded.error : "",
      accepted: decoded.accepts?.[0],
    };
  } catch {
    return { error: "", accepted: undefined };
  }
}

/** The settle response's extra is merged by the server and the facilitator; to the agent it is external input. */
const settleExtraSchema = z.object({
  channelState: z
    .object({
      channelId: z.string().optional(),
      balance: z.string().optional(),
      chargedCumulativeAmount: z.string().optional(),
    })
    .optional(),
});

/**
 * Pay for one tick. If the local channel record is stale, drop it and retry once --
 * only once, so we don't loop forever when the chain really has no money.
 */
export async function payTick(
  wallet: ReturnType<typeof createWallet>,
  config: AppConfig,
  sessionId: string,
): Promise<PayResult> {
  try {
    return await attemptTick(wallet, config, sessionId);
  } catch (e) {
    if (!(e instanceof StaleChannelError)) throw e;
    await wallet.forgetChannel(e.accepted);
  }
  try {
    return await attemptTick(wallet, config, sessionId);
  } catch (e) {
    // Still short after rebuilding from the chain -- this time the deposit really is gone and can't be topped up.
    if (e instanceof StaleChannelError) {
      throw new Error("Deposit cannot cover the next tick and could not be topped up - check the USDC balance of the buyer's wallet");
    }
    throw e;
  }
}

async function attemptTick(
  wallet: ReturnType<typeof createWallet>,
  config: AppConfig,
  sessionId: string,
): Promise<PayResult> {
  const res = await wallet.paidFetch(`${config.serverBaseUrl}/tick`, {
    method: "POST",
    headers: { "X-Drip-Session": sessionId, "Content-Type": "application/json" },
    body: "{}",
  });

  if (res.status === 409) throw new SessionCutError();
  if (!res.ok) {
    const { error: reason, accepted } = res.status === 402
      ? decodePaymentRequired(res)
      : { error: "", accepted: undefined };
    const detail = (await res.text().catch(() => "")) || reason;
    // Cap exceeds the deposit = the local record is more optimistic than the chain; drop it and try again.
    if (reason.includes("cumulative_exceeds_balance") && accepted) {
      throw new StaleChannelError(accepted);
    }
    // Only match an insufficient balance at the wallet level. Never loosen this to /balance/ --
    // that would also misread the channel's cumulative_exceeds_balance as an empty wallet.
    if (res.status === 402 && /insufficient[ _-]?(funds|balance)/i.test(`${reason} ${detail}`)) {
      throw new Error(`Insufficient USDC balance - get some from the Circle faucet (${reason || detail})`);
    }
    throw new Error(`Payment failed: HTTP ${res.status}${reason ? ` ${reason}` : ""} ${detail}`.trim());
  }

  const body = (await res.json()) as { sessionId: string };
  // txHash comes in a header, not the body (spec §2.5)
  const settle = wallet.httpClient.getPaymentSettleResponse((n) => res.headers.get(n));
  const parsed = settleExtraSchema.safeParse(settle.extra);
  const channelState = parsed.success ? parsed.data.channelState : undefined;
  const channelId = channelState?.channelId;
  const clientChannel = channelId ? await wallet.storage.get(channelId) : undefined;

  return {
    sessionId: body.sessionId,
    txHash: settle.transaction || undefined,
    channelBalance: channelState?.balance,
    // Exposure is the "signed cap", not "consumed" (spec §2.4). The package only writes signedMaxClaimable
    // after a corrective recovery; normally the two are equal, so fall back to consumed as an approximation.
    signedCeiling: clientChannel?.signedMaxClaimable ?? clientChannel?.chargedCumulativeAmount,
    chargedCumulative: channelState?.chargedCumulativeAmount,
  };
}
