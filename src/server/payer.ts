export class PayerUnknownError extends Error {
  constructor() {
    super("cannot determine payer identity, refusing to create session");
    this.name = "PayerUnknownError";
  }
}

type MaybeExactPayload = {
  authorization?: { from?: unknown };
  channelConfig?: { payer?: unknown };
};

function asAddress(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v.toLowerCase() : null;
}

/**
 * The single source of payer identity.
 * authorization.from is required and part of the EIP-712 signature; SettleResponse.payer is optional,
 * a fallback only. If both are empty we must throw — binding undefined would make the payer comparison always true (spec §2.6).
 */
export function extractPayer(payload: unknown, settlePayer?: string): string {
  const from =
    typeof payload === "object" && payload !== null
      ? asAddress((payload as MaybeExactPayload).authorization?.from) ??
        asAddress((payload as MaybeExactPayload).channelConfig?.payer)
      : null;

  const fallback = asAddress(settlePayer);
  const payer = from ?? fallback;
  if (payer === null) throw new PayerUnknownError();
  return payer;
}
