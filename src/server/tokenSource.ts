export interface TokenSource {
  open(): AsyncIterable<string>;
}

const CANNED =
  "What matters in streaming payments isn't the size of the amount but who holds the power to enforce. Traditional billing assumes someone will press confirm, " +
  "but payments between machines are high-frequency, tiny, and account-free. The moment payment stops, the line should go dead.";

/**
 * The PoC's inference backend. Hooking up a real LLM later only means swapping this implementation; the billing layer needs no changes.
 */
export function cannedTokenSource(text: string = CANNED): TokenSource {
  const tokens = text.match(/.{1,4}/gu) ?? [text];
  return {
    async *open(): AsyncIterable<string> {
      let i = 0;
      while (true) {
        yield tokens[i % tokens.length]!;
        i += 1;
      }
    },
  };
}
