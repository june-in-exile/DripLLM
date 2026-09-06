export interface TokenSource {
  open(): AsyncIterable<string>;
}

const CANNED =
  "串流付費的重點不在金額大小,而在於強制力握在誰手上。傳統扣款假設有人會按下確認," +
  "而機器之間的付款是高頻、微額、免帳號的。停止付款的那一刻,線就該斷。";

/**
 * PoC 的推論後端。日後接真實 LLM 只需替換此實作,收費層無須改動。
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
