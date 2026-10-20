/**
 * @x402/evm's refundChannel throws this message locally (without going on-chain) when the deposit is fully consumed.
 * This is not a failure -- no money is locked in the channel; there is just nothing to refund.
 * Relies on the package's error string; if the package changes the wording, the tests break first instead of silently misjudging.
 */
const NOTHING_TO_REFUND = "channel has no remaining balance";

export function isNothingToRefund(error: unknown): boolean {
  return error instanceof Error && error.message.includes(NOTHING_TO_REFUND);
}
