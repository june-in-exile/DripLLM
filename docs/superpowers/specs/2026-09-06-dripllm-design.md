# DripLLM 設計文件

**日期:** 2026-09-06
**狀態:** 已定案,實作進行中
**範圍:** 概念驗證(PoC)

---

## 1. 目標

**讓沒有計費基礎設施的小型推論供應商,能對機器客戶按秒收費,而雙方都不需要對彼此授信。**

用一個可跑的最小系統示範:買方 agent 掛在一條推論串流上持續付費,一旦停付,賣方 server 主動切斷連線。

### 1.1 要解決的問題

小型 LLM 供應商想收費,得先自己建一整套東西:帳號系統、金流串接、發票、授信與催收、退款爭議、防詐。**這套成本與客戶數無關,是固定門檻** —— 大公司攤得掉,一個人跑自架模型的攤不掉。

DripLLM 這條路,供應商只需要一個收款地址加一段 middleware。沒有帳號、沒有發票、沒有授信風險、沒有 chargeback,而且第一天就是全球的。

### 1.2 為什麼是「按秒」而不是「按 token」

按 token 計費是大公司在抽象掉硬體之後的定價方式。**小型自架供應商的真實成本是 GPU 被佔用的時間** —— 一個人跑一張卡,他的成本就是秒數。按時間計費對這個受眾比按 token 更貼合成本結構,不是為了 demo 方便而做的簡化。

### 1.3 為什麼不能只用原生的 per-request x402

一般的 request/response API,per-request 付款本來就解決了問題:沒付錢就 402,拿不到回應,曝險等於零。**那種場景本專案沒有加分。**

沒有現成答案的是**串流** —— 一段跑好幾分鐘的推論,「一次請求」不是自然的計費單位。此時只剩兩個爛選擇:

| 做法 | 誰承擔風險 |
| --- | --- |
| 整段預收 | 買方承擔對手方風險(付了錢對方跑掉) |
| 先給後收 | 賣方承擔授信風險(送完了對方不付) |

DripLLM 的答案是第三條:**把時間切成 `CREDIT_PER_TICK_MS` 一格,任一方對另一方的曝險都不超過一格。**

### 1.4 這個 demo 證明的不是「能不能斷」

「沒錢就沒服務」是所有計費模型的共同點,不值得做 demo。有意義的量只有一個:**從停止付款,到服務真的停下來,中間的曝險窗口有多大。**

以 session 預先授權為基礎的 agent 錢包(如 Kite Agent Passport)走的是相反的取捨 —— 先核准一筆預算與時限,agent 在框內自主花費,換取「不必每次再問」的便利;代價是在撤銷之前,整筆預算的曝險是實際存在的。

兩者不衝突,解的是不同層:**session 授權管的是「買方能不能花」,DripLLM 管的是「賣方在對方停付時能多快收手」。**

### 1.5 一個硬邊界:機器客戶,不是人類客戶

門檻並未消失,而是**換邊**了:供應商不必再建計費系統,但**每個客戶都得有一個裝了 USDC 的錢包**。

對人類客戶這是死穴 —— 沒有人為了用一個小模型去開錢包買 USDC。對 agent 客戶則不是,agent 本來就是被程式佈建出來的,發個錢包給它是一行程式。

這就是為什麼本專案落在 agent payment 這個題目底下,而不是一般的 SaaS 計費。

### 1.6 非目標

- 不做真實 LLM 推論(PoC 用罐頭 token 串流,介面可抽換)
- 不做多買方、多 session 的規模化
- 不做前端網頁,demo 是兩個並排的終端
- 不上主網,不碰真實資產
- 不自己寫智能合約,鏈上驗證與結算交給 facilitator

---

## 2. 核心設計決策

### 2.1 斷流必須由 server 執行(關鍵決策)

考慮過兩種形狀:

| 方案 | 斷流的樣子 | 問題 |
| --- | --- | --- |
| 每 tick 一個獨立 request | agent 自己 break 迴圈 | 畫面上分辨不出「server 強制」與「agent 自願停止」,server 從頭到尾沒行使任何權力 |
| **SSE 長連線 + 付款心跳(採用)** | server 主動 `res.end()` | agent 還連著、還想要,但線被剪了 —— 強制力可見 |

**採用 SSE 長連線。** Ctrl-C 之所以能當 demo 觸發鍵,只在這個方案下成立。

### 2.2 三個端點,只有一個收費

| 端點 | x402 | 職責 |
| --- | --- | --- |
| `POST /tick` | 收費 | 付一筆 → 建立或延長 session。回 `{ sessionId, accepted: true }` |
| `GET /stream?sessionId=` | 免費 | SSE,session 活著就吐 token |
| `GET /health` | 免費 | demo 腳本與啟動檢查用 |

`/stream` 免費不構成漏洞:**session 只有付過錢才存在**,而 session 僅在 `POST /tick` 付款結算成功後才由 hook 建立(§2.5),因此不存在拿到免費 token 的路徑。此設計讓 x402 middleware 留在它天生擅長的 per-request 位置,SSE 那條完全不碰付款邏輯。

#### 2.2.1 端點細節

- **sessionId 由 agent 產生**,`crypto.randomUUID()`,每次 `POST /tick` 以 `X-Drip-Session` header 送出。理由見 §2.5 —— session 的建立與延長發生在 settle 完成後的 hook 裡,而 hook 無法回頭改寫已定案的 response body,因此 id 必須由呼叫方提供。

- **被剪除的 sessionId 不可重用(tombstone),由 handler 在結算前擋下。** server 保留一個短時效(`TOMBSTONE_TTL_MS`)的已剪除 id 集合。`POST /tick` 的 handler 若發現送來的 id 命中該集合,**回 409**。

  關鍵在於時機:middleware 的順序是 verify → handler → settle,且 dist 中 `if (res.statusCode >= 400)` 會呼叫 `cancellationDispatcher.cancel({ reason: "handler_failed" })` **取消結算**。因此 handler 回 409 時付款尚未上鏈,agent 不會被扣款。agent 收到 409 後產生新 UUID 重試即可。

  理由:id 由 client 產生,agent 收到 `event: cut` 後若沿用同一顆 UUID 繼續付款,會讓已被 watchdog 清除的 session 以同一個 id 復活,`tickCount` 與 `spentAtomic` 從零重算,demo 最後的結算摘要因此少計。

  **不可改用「照收付款並改發新 id」的做法** —— 那需要把新 id 寫進 response body,而 body 在 handler 呼叫 `res.end()` 時就已定案並緩衝,hook 改不動(與 txHash 同一個成因,見 §2.5)。agent 會拿著舊 id 去開 SSE 並得到 404。

  agent 端另應在收到 `cut` 後主動換新 UUID,兩層都做。

- **`POST /tick` 帶了不存在(且未被 tombstone)的 sessionId:** 視同新 session 建立。付款已經發生,拒絕等於收錢不給貨。

- **`POST /tick` 的回應不含 txHash。** tx hash 由 middleware 在 settle 後寫入 `X-PAYMENT-RESPONSE` header。agent 端讀法(注意須傳入 getHeader 函式,非無參數呼叫):

  ```ts
  import { x402HTTPClient } from "@x402/core/client";
  // getPaymentSettleResponse(getHeader: (name: string) => string | null | undefined): SettleResponse
  const settle = new x402HTTPClient(client)
    .getPaymentSettleResponse((n) => response.headers.get(n));
  const txHash = settle.transaction;
  ```

- **SSE 事件三種:**
  - `event: token` — `data` 為一段推論文字
  - `event: credit` — `data` 為 `{ "remainingMs": n, "grace": bool, "tickCount": n, "spentAtomic": "..." }`,每 `CREDIT_EVENT_MS` 送一次
  - `event: cut` — `data` 為 `{ "sessionId": "...", "reason": "payment_lapsed", "tickCount": n, "spentAtomic": "..." }`,送出後立即關閉連線

- **`remainingMs` 允許為負值**,且進入寬限期時 `grace: true`。若 clamp 在 0,agent 無法區分「餘額將盡」與「已逾期、正在寬限期內」,而 §4 的終端輸出正是要把這兩段分開呈現。

- **第一筆 tick 不由 `event: credit` 驅動。** 補款時機雖由 credit 事件驅動,但 tick #1 發生時 session 尚不存在、SSE 也尚未開啟。agent 的啟動序列為:產生 UUID → `POST /tick`(建立 session)→ 以回應的 sessionId 開啟 SSE → 其後改由 `event: credit` 驅動補款。

### 2.3 信用額度模型,不是固定鬧鐘

一筆付款買到一段**串流時間**,agent 在**餘額將盡時**補款,而非固定間隔付款。

若「每 N 秒付一次」且「一筆買 N 秒」,延遲會讓餘額逐 tick 向下漂移,數個 tick 後系統會在使用者未介入的情況下自行斷流。補款條件為餘額低於 `TOPUP_THRESHOLD_MS`,由 SSE 的 `event: credit` 驅動。

**漂移的主要來源是鏈上結算,不是網路。** 見 §2.5。由此推出一條硬性約束:

```
TOPUP_THRESHOLD_MS > settle wall-clock
CREDIT_PER_TICK_MS > TOPUP_THRESHOLD_MS(需有明顯餘裕)
```

agent 必須在餘額耗盡前**至少一個 settle 週期**啟動補款,否則付款永遠追不上消耗。settle 實測值決定這兩個參數,因此 §8 的實作順序以量測 spike 開頭。

### 2.4 SSE 連線物件不進 session 記錄

`Session` 是唯讀純資料;Express 的 `Response` 物件存在旁邊一張副表 `Map<sessionId, Response>`。

理由:斷流的正確性完全取決於 session 帳本的時序邏輯,把它保持成純函數 + 純資料,才能用假時鐘把所有邊界測到底而不必啟動 HTTP。

---

### 2.5 session 的建立與延長發生在 `onAfterSettle`,不在 Express handler

**經 `@x402/express@2.25.0` 的 dist 原始碼確認:settle 位於回應的關鍵路徑上。** middleware 劫持 `res.writeHead/write/end/flushHeaders` 全部緩衝,`await endPromise`(等 handler 呼叫 `res.end`)後才執行 `processSettlement`(上鏈),最後才在 `finally` 中把緩衝的 response 重播出去。**settle 完成前 client 收不到任何一個 byte。**

因此 `POST /tick` 的 wall-clock = 402 challenge RTT + 簽章 + verify RTT + Fuji 上鏈結算。

若在 handler 內計算 `paidUntil = now + CREDIT`,agent 要在 settle 完成後才收到回應,實際買到的串流時間是 `CREDIT − settle 延遲`。這正是 §2.3 要避免的漂移,只是來源是結算而非網路。

**解法:** 把 session 的建立與延長移到 `x402ResourceServer.onAfterSettle(hook)`。

- `paidUntil` 從 **settle 完成的時刻**起算,結算延遲不再侵蝕額度
- hook 的 `SettleResultContext.result` 帶 `SettleResponse`,其中 `transaction` 即 tx hash(必填)。付款地址不可用 `result.payer`,理由見 §2.6
- hook 僅在 settle 成功時觸發,§7「settle 失敗不延長 `paidUntil`」自然成立,無需補償回滾
- hook 可經 `transportContext` 讀取原始 request。完整路徑(已在 dist 中追過三層):

  ```ts
  // AfterSettleHook 收到的是 { ...settleContext, result, transportContext }
  // transportContext 是 HTTPTransportContext = { request: HTTPRequestContext, responseBody, responseHeaders }
  // HTTPRequestContext.adapter 是 HTTPAdapter,其 getHeader(name) 直通 Express 的 req
  const sessionId = ctx.transportContext.request.adapter.getHeader("X-Drip-Session");
  ```

**但 hook 無法改寫 response body。** body 在 handler 呼叫 `res.end()` 時就已定案並緩衝,hook 在其後執行且回傳 `Promise<void>`。因此:

- `POST /tick` 的 body 只回 `{ sessionId, accepted: true }`(sessionId 是 agent 送來的,handler 原本就知道)
- **tx hash 走 header**:middleware 在 settle 後 `res.setHeader` 寫入 `X-PAYMENT-RESPONSE`,agent 以 `x402HTTPClient.getPaymentSettleResponse()` 讀取
- **餘額走 SSE**:`event: credit` 事件回報 `remainingMs`,agent 據此決定補款時機

**限制:** hook 只能經 `paymentMiddleware(routes, server, ...)` 或 `paymentMiddlewareFromHTTPServer` 掛載,`paymentMiddlewareFromConfig` 接不到。v2.25.0 這三個函式皆為位置參數而非 options 物件,`syncFacilitatorOnStart` 是第 5 個位置參數。

**已知殘留風險:** 若 settle 成功但 hook 拋錯,agent 會收到 200 但 `/stream` 回 404。PoC 接受此情況,agent 對首次 `/stream` 404 重試一次後放棄並明確報錯。

### 2.6 付款者身分取自 `authorization.from`,不可取自 `result.payer`

session 綁定首次付款地址,後續 tick 的付款者不符即拒絕延長(§2.2.1)。**此地址必須取自 payment payload 的 `authorization.from`。**

```ts
type SettleResponse  = { ...; payer?: string; transaction: string; ... };  // payer 為 optional
type VerifyResponse  = { ...; payer?: string; ... };                       // 同樣 optional

type ExactEIP3009Payload = {
  signature?: `0x${string}`;
  authorization: {
    from: `0x${string}`;   // 必填,且屬於 EIP-712 簽章的一部分
    ...
  };
};
```

若以 `result.payer` 綁定,而 facilitator 未回填該欄位,首次付款會把 `undefined` 寫進 session,後續每一筆的付款者同樣是 `undefined`,`undefined === undefined` 恆為真 —— **保護完全失效,且全程不會產生任何錯誤訊息**。這比不做綁定更危險,因為文件會讓實作者以為已經擋住了。

`authorization.from` 是必填欄位,且 facilitator 剛驗過的 EIP-712 簽章正是對它簽的,因此在密碼學上綁定,不依賴 facilitator 是否肯回填某個 optional 欄位。

**取值規則:**

```
payer = authorization.from ?? result.payer
若兩者皆空 → 立即拋錯,拒絕建立 session,絕不綁定 undefined
```

`paymentPayload.payload` 的宣告型別是 `Record<string, unknown>`,需 cast 為 `ExactEIP3009Payload`。此 cast 應集中在 `settleHook.ts` 的單一函式中,並使 payer 成為 `upsertSession` 的純函數輸入,以便在第 1 層測試中直接驗證不符情境。

## 3. 技術選型(均已驗證)

### 3.1 套件

使用 **x402 協定 v2**:`@x402/express`、`@x402/core`、`@x402/evm`、`@x402/fetch`、`viem`。

> **不使用 `x402-express`。** v1 已 deprecated,僅接收 security patch。v2 的 API 形狀與 network 識別字皆不同。注意 thirdweb 等第三方文件多半仍停在 v1 寫法。

network 識別字採 CAIP-2 格式:`eip155:43113`(非 v1 的 `"avalanche-fuji"`)。

**版本鎖定 `2.25.0`。** 本文件所有關於套件內部行為的敘述,皆以實際安裝的 `2.25.0` dist 為準。`coinbase/x402` 的 `main` branch 與已發佈版本存在差異(見 §3.3),不可用 GitHub 上的原始碼推斷已發佈版本的行為。

### 3.2 鏈與資產(Avalanche Fuji 測試網)

| 項目 | 值 |
| --- | --- |
| Chain ID | 43113(CAIP-2:`eip155:43113`) |
| RPC | `https://api.avax-test.network/ext/bc/C/rpc` |
| USDC 合約 | `0x5425890298aed601595a70AB815c96711a31Bc65` |
| EIP-712 domain name | `USD Coin` |
| EIP-712 domain version | `2` |
| decimals | `6` |
| EIP-3009 | 已確認支援(`authorizationState()` 有回應) |
| AVAX faucet | Core Wallet console |
| USDC faucet | Circle faucet |

上述 `name` / `version` / `decimals` / EIP-3009 皆由 `eth_call` 直接自 Fuji 鏈上讀取確認。

> **`name` 是 `USD Coin`,不是 `USDC`。** Base Sepolia 的 USDC domain name 為 `USDC`,Fuji 為 `USD Coin`。此值是 EIP-712 domain 的一部分,填錯會導致簽章驗證失敗,且錯誤訊息不會指向此處。

### 3.3 價格必須顯式指定資產(server 端)

`@x402/evm@2.25.0` 匯出 `DEFAULT_ASSETS`(以及 `findDefaultAsset`、`getDefaultAsset`)。實際列出該表的 EVM 網路:

```
eip155:1, 14, 50, 51, 137, 143, 988, 1328, 1329, 2201, 4326, 8453,
31611, 31612, 36900, 38833, 42161, 42220, 43114, 72344, 84532,
181228, 190415, 421614, 723487, 11142220
```

**`eip155:43114`(Avalanche 主網)在表內,`eip155:43113`(Fuji)不在。** 因此 `price: "$0.001"` 搭配 `network: "eip155:43113"` 無法解析出資產位址。

`price` 亦接受 `AssetAmount` 物件,故採顯式寫法:

```ts
price: {
  amount: "1000",                                    // 0.001 USDC(6 decimals)
  asset: "0x5425890298aed601595a70AB815c96711a31Bc65",
  extra: { name: "USD Coin", version: "2" },
}
```

> **注意版本差異。** `coinbase/x402` 的 `main` branch 中此表名為 `DEFAULT_STABLECOINS` 且不含任何 Avalanche 網路;已發佈的 `2.25.0` 則名為 `DEFAULT_ASSETS` 且含主網 43114。以安裝版本為準,勿依 GitHub 原始碼推斷。

### 3.3.1 client 端必須開放 Fuji 資產

`x402Client` 的 `spendControls` **預設只允許 `findDefaultAsset` 認得的資產**。由於 Fuji 不在 `DEFAULT_ASSETS` 中,預設設定會直接拒付,且錯誤訊息不會指向此處。

必須顯式開放:

```ts
spendControls: {
  allowedAssets: [{
    network: "eip155:43113",
    asset: "0x5425890298aed601595a70AB815c96711a31Bc65",
    maxAmountPerPayment: "1000",   // 整數 atomic 單位,不是 "$1"
  }],
}
```

`maxAmountPerPayment` 在此同時充當單筆付款的硬上限,與 agent 自己的累計花費上限(`MAX_SPEND_ATOMIC`)是兩層獨立防線。

### 3.4 Facilitator:自架 x402-rs

不使用託管服務。`facilitator.x402.rs` 的託管實例不支援 Fuji;thirdweb 託管需綁第三方帳號且文件停留在 v1。

自架 x402-rs 的 `config.json` 按 CAIP-2 chain id 泛用配置,加入 `eip155:43113` 條目即可支援 Fuji,無須等待上游支援。x402-rs 已完整支援協定 v2(scheme `v2-eip155-exact`)。

```json
{
  "port": 8080,
  "host": "0.0.0.0",
  "chains": {
    "eip155:43113": {
      "eip1559": true,
      "signers": ["$FACILITATOR_PRIVATE_KEY"],
      "rpc": [{ "http": "https://api.avax-test.network/ext/bc/C/rpc" }]
    }
  },
  "schemes": [
    { "id": "v2-eip155-exact", "chains": "eip155:43113" }
  ]
}
```

Docker:`ghcr.io/x402-rs/x402-facilitator`,掛載 config.json 至 `/app/config.json`,對外 8080。
端點:`/verify`、`/settle`、`/supported`、`/health`。

**facilitator 的 signer 錢包需自備 AVAX 支付 gas。**

---

## 4. 執行時序

```
agent                          server                      facilitator
  │                              │                              │
  ├─ POST /tick ────────────────▶│                              │
  │◀──────────── 402 + 價格/資產 ─┤                              │
  ├─ POST /tick + X-PAYMENT ────▶├─ verify ────────────────────▶│
  │                              │◀─────────────────────── ok ──┤
  │                              ├─ settle ────────────────────▶│──▶ Fuji
  │                              │◀──────── SettleResponse ─────┤
  │                              ├─ onAfterSettle: 建立 session  │
  │                              │   paidUntil = 此刻 + CREDIT   │
  │◀── {sessionId, accepted} ────┤   (response 至此才被 flush)   │
  ├─ GET /stream?sessionId ─────▶│                              │
  │◀════ token / credit 事件 ═════╡
  │                              │
  ├─ POST /tick(收到 event:credit ─▶│ paidUntil = max(now, paidUntil) + CREDIT
  │   且 remainingMs < 門檻時)     │  (同樣在 settle 完成後才計算)
  │◀════ token token token ══════╡
  │                              │
  │  ^C 停付,連線保持             │
  │◀════ token token ════════════╡  餘額燒完 + 寬限 2s 內照流
  │                              │  watchdog: now > paidUntil + GRACE_MS
  │◀──── event: cut ─────────────┤
  │◀──── [connection closed] ────┤
```

**停付至斷線的間隔 = 停付當下的剩餘餘額 + `GRACE_MS`。**

以 §5 的暫定值(CREDIT 5s / TOPUP 2s / GRACE 2s)推算,停付當下餘額落在 2～5 秒,故間隔為 4～7 秒。**但 §5 尚未定案** —— 若 spike 量出的 settle 耗時迫使 `CREDIT_PER_TICK_MS` 上調,此區間需連同重算。

此範圍的變動性是刻意保留的 —— 讓每次 demo 略有不同,看起來像真的在燒餘額而非跑腳本。

server 端須將倒數輸出至終端,讓觀眾理解那幾秒不是當機:

```
[server] session 7f3a · 餘額 1.2s
[server] session 7f3a · 餘額 0.4s
[server] session 7f3a · ⚠ 逾期,寬限 2.0s
[server] session 7f3a · ✂ 切斷串流
```

---

## 5. 參數

> **以下數值為暫定,須由 §8 的量測 spike 定案。** 目前的值是設計時估的,未經實測。若 settle wall-clock 實測為 4 秒,`CREDIT_PER_TICK_MS` 需自 5000 拉高至 20000 上下,並連動重算 §4 的時序、demo 節奏與 §10 的驗收標準 #5。

| 參數 | 暫定值 | 說明 |
| --- | --- | --- |
| `CREDIT_PER_TICK_MS` | `5000` | 一筆付款買到的串流時間 |
| `TOPUP_THRESHOLD_MS` | `2000` | 餘額低於此值即補款 |
| `GRACE_MS` | `2000` | 逾期後 server 才剪線的寬限 |
| `PRICE_PER_TICK_ATOMIC` | `1000` | 0.001 USDC |
| `MAX_SPEND_ATOMIC` | `50000` | 0.05 USDC,約 50 個 tick |
| `TOKEN_INTERVAL_MS` | `120` | token 送出間隔,模擬串流節奏 |
| `CREDIT_EVENT_MS` | `500` | `event: credit` 的送出間隔 |
| `WATCHDOG_SWEEP_MS` | `250` | 單一掃描 timer 的週期 |
| `TOMBSTONE_TTL_MS` | `60000` | 已剪除 sessionId 的保留時間,擋重用 |

必須滿足的約束(見 §2.3):

```
TOPUP_THRESHOLD_MS > settle wall-clock
CREDIT_PER_TICK_MS > TOPUP_THRESHOLD_MS(需有明顯餘裕)
GRACE_MS 決定「停付到剪線」的下界
```

所有參數經 `src/config.ts` 以 zod 驗證後注入,無硬編碼。測試以注入小常數的方式縮短週期(見 §8)。

## 6. 元件與檔案結構

```
DripLLM/
├── docker-compose.yml            facilitator 一鍵起
├── facilitator/config.json       eip155:43113 + v2-eip155-exact
├── .env.example
├── src/
│   ├── config.ts                 zod 驗證所有 env
│   ├── shared/
│   │   ├── usdc.ts               Fuji 資產常數 + atomic 換算
│   │   └── logger.ts             結構化終端輸出
│   ├── server/
│   │   ├── main.ts               bootstrap
│   │   ├── payment.ts            x402 middleware 組裝(顯式 AssetAmount)
│   │   ├── settleHook.ts         onAfterSettle —— session 建立/延長的唯一入口
│   │   ├── payer.ts              自 payload 取出付款者身分(§2.6)
│   │   ├── sessions.ts           不可變 session 帳本(純函數)
│   │   ├── registry.ts           store 的唯一持有者(§6.3.1)
│   │   ├── watchdog.ts           單一 sweep timer + 剪線
│   │   ├── stream.ts             SSE handler
│   │   ├── tick.ts               POST /tick
│   │   └── tokenSource.ts        TokenSource 介面 + 罐頭實作
│   └── agent/
│       ├── main.ts               bootstrap + SIGINT 兩段式
│       ├── wallet.ts             viem signer + x402Client
│       ├── ledger.ts             花費上限與累計(純函數)
│       ├── sse.ts                手寫 SSE 解析(Node 無 EventSource,見 §6.5)
│       ├── heartbeat.ts          補款迴圈(由 event: credit 驅動)
│       └── render.ts             終端輸出
└── tests/
```

每個檔案預期在 100–150 行內。

### 6.1 Session 帳本介面

```ts
export type Session = Readonly<{
  id: string;
  payer: string;          // 取自 authorization.from,見 §2.6;後續 tick 須相符
  paidUntilMs: number;
  spentAtomic: bigint;
  tickCount: number;
  lastTxHash: string;
}>;

export type SessionStore = ReadonlyMap<string, Session>;

upsertSession(store, id, payer, nowMs, creditMs, priceAtomic, txHash):
    { store: SessionStore; session: Session; rejected?: "payer_mismatch" }
expiredSessions(store, nowMs, graceMs):   readonly Session[]
removeSession(store, id):                 SessionStore
remainingMs(session, nowMs):              number      // 可為負值,見 §2.2.1
inGrace(session, nowMs, graceMs):         boolean
```

全為純函數:`id`、`payer`、`nowMs`、`txHash` 皆由呼叫端傳入,函數內不呼叫 `crypto.randomUUID()` 或 `Date.now()`。這是 §2.4 所稱「用假時鐘測到底」的前提。

`upsertSession` 合併了原先的 `createSession` / `extendSession`:兩者的差別僅在 store 中有無該 id,而 §2.2.1 已定義兩種情況的行為相同(建立或延長),拆成兩個函式只會讓呼叫端多一次分支判斷。

### 6.2 Token 來源介面

```ts
export interface TokenSource {
  open(): AsyncIterable<string>;
}
```

PoC 實作循環吐出一段罐頭文字。日後接真實 LLM 只需替換此檔案的實作,收費層無須改動。

### 6.3 Watchdog

**單一** `setInterval(WATCHDOG_SWEEP_MS)` 掃描全部 session,而非每條連線一個 timer。

剪線步驟必須依此順序:

1. **先把 session 物件取下來**(`tickCount`、`spentAtomic` 之後要用)
2. 自帳本 `removeSession(store, id)`,並把 id 記入 tombstone 集合
3. 送 `event: cut`,payload 使用步驟 1 取下的值
4. `res.end()`

步驟 1 不可省略:`event: cut` 的 payload 帶 `tickCount` 與 `spentAtomic`,若在移除後才取,兩者會是 `undefined` —— 而那正是 demo 最後一行的結算摘要。

步驟 2 先於 4 的理由:`res.end()` 會觸發 Express 的 `close` 事件,與「agent 主動斷線」走同一個 handler。先移除帳本,`close` handler 便可用「該 id 是否仍在帳本中」區分兩者 —— 仍在代表 agent 自己斷的,已不在代表是 watchdog 剪的。日誌因此能正確標示,而那正是整個 demo 要證明的區別。清除操作本身是冪等的。

#### 6.3.1 不可變 store 的持有方式

帳本是不可變的,每次更新都產生新物件。因此 `close` handler、watchdog、hook **都不得閉包捕獲 store 本身**,否則永遠讀到註冊當下的舊快照,上述的「是否仍在帳本中」判斷會全部反向。

所有存取一律經由單一持有者:

```ts
// registry.ts —— 唯一可變的一格,內容仍是不可變資料
const registry = { current: new Map() as SessionStore };
export const getStore = () => registry.current;
export const setStore = (next: SessionStore) => { registry.current = next; };
```

handler 內一律 `getStore()` 現讀,不接受 store 作為參數捕獲。§6.1 的純函數本身仍接收 store 參數並回傳新 store —— 可變性被侷限在這一格,純函數與其測試不受影響。

### 6.4 Agent 的 SIGINT 兩段式

- 第一次 Ctrl-C:`paying = false`,輸出「已停止付款,連線保持中」,**繼續讀取 stream**
- 第二次 Ctrl-C:真正退出

第一段是整個 demo 成立的關鍵 —— agent 仍連線、仍在等待,線是 server 剪的。

---

### 6.5 SSE 解析(agent 端)

Node v26.5.0 實測 `typeof EventSource === "undefined"`,需 `--experimental-eventsource` 旗標才有。PoC 不依賴實驗性旗標,改以 `fetch` 取得 `ReadableStream` 後手寫解析。

`src/agent/sse.ts` 需處理:chunk 邊界可能切在 SSE frame 中間(以 `\n\n` 分隔),因此須保留未消化的尾段緩衝區,逐次累加後再切分。此檔案有獨立的純函數單元測試(見 §8),餵入刻意切碎的 chunk 序列驗證 frame 還原。

## 7. 錯誤處理

| 情況 | 行為 | 使用者訊息 |
| --- | --- | --- |
| 啟動時 facilitator 無回應 | server 拒絕啟動 | `facilitator 無回應 (localhost:8080) —— 先跑 docker compose up` |
| facilitator 中途失效 | `/tick` 回 503,session 自然逾期被剪 | `付款服務中斷,串流即將斷線` |
| settle 失敗(facilitator 無 gas) | `onAfterSettle` 不觸發,session 不建立/不延長;middleware 丟棄 handler 的 body 改送自己的 402 | `結算失敗:facilitator 錢包 AVAX 不足` |
| agent USDC 不足 | settle revert | `USDC 餘額不足 —— 前往 Circle faucet 領取` |
| sessionId 不存在或已過期 | `/stream` 回 404 | `session 不存在或已過期,請先付款` |
| 同一 sessionId 開第二條 SSE | 回 409,拒絕 | 防止一份付款餵多條串流 |
| agent 連線中斷 | 清除 session 與副表項目 | (防止 watchdog 資源洩漏) |
| settle 成功但 hook 拋錯 | agent 收到 200 但 `/stream` 回 404 | agent 重試一次後放棄:`session 建立失敗,該筆付款已結算但未生效` |
| tick 的 payer 與 session 不符 | hook 拒絕延長並記錄;**無法回 403**,因為 hook 在 response 定案後才執行。該 session 不再續命,最終由 watchdog 剪線 | server 端日誌:`session 屬於其他付款者,拒絕延長` |
| `authorization.from` 與 `result.payer` 皆空 | 立即拋錯,不建立 session(見 §2.6) | `無法確認付款者身分,拒絕建立 session` |
| tick 的 sessionId 命中 tombstone | handler 回 409,middleware 取消結算,**不扣款** | agent 產生新 UUID 後重試 |
| env 缺漏或格式錯 | zod 於啟動時失敗 | **一次列出全部**缺漏項,而非只報第一個 |
| 花費上限用罄 | agent 停付但保持連線 | `已達上限 $0.05,停止付款 —— 等待 server 斷流` |

---

## 8. 測試策略與實作順序

TDD:先寫測試(RED)、再實作(GREEN)、後重構。涵蓋率門檻 80%,掛在第 1、2 層,spike 與第 3 層排除計算。

### 第 0 步 — 量測 spike(先於一切實作)

**產出是三個數字,不是要保留的程式碼。**

起 facilitator,寫一支約 30 行的拋棄式腳本,對真實 Fuji 跑一次完整 tick,量測:

1. 402 challenge RTT
2. verify RTT
3. **settle wall-clock**(最關鍵)

依實測值定案 §5 的 `CREDIT_PER_TICK_MS` 與 `TOPUP_THRESHOLD_MS`,並回頭更新 §4 時序圖與 §10 驗收標準 #5 的秒數。

理由見 §2.5:settle 位於回應的關鍵路徑上,其耗時直接決定參數是否可行。在不知道這個數字的情況下寫下去,等於賭 demo 不會自己斷流。腳本跑完即丟。

### 第 1 層 — 純函數單元測試(涵蓋率主力)

vitest + fake timers,毫秒級。

- `sessions.test.ts` — `upsertSession` 建立/延長/payer 不符、`remainingMs`(含負值)、`inGrace`、`expiredSessions`、`removeSession`
- `payer.test.ts` — `authorization.from` 優先、`result.payer` 後備、**兩者皆空時必須拋錯而非綁定 undefined**(§2.6)
- `watchdog.test.ts` — 寬限期邊界:grace 內剛好不剪、超過 1ms 即剪;剪線順序(先取值 → 移除 → cut → end);`event: cut` 的 payload 含正確的 `tickCount` / `spentAtomic`
- `registry.test.ts` — 更新 store 後,先前取得的存取器仍讀到新值(§6.3.1 的舊快照問題)
- `ledger.test.ts` — 花費上限邊界:餘額剛好等於單筆價格時是否付款
- `sse.test.ts` — frame 還原:chunk 切在 `\n\n` 中間、單一 chunk 含多個 frame、跨三個 chunk 的長 frame
- `usdc.test.ts` — atomic 換算精度、溢位與負值拒絕
- `config.test.ts` — 各種缺漏與格式錯誤的 env

### 第 2 層 — HTTP 合約測試(不碰鏈)

supertest + **假 facilitator**(Express,`/verify`、`/settle`、`/supported` 直接回成功,`/settle` 回一個假 `transaction` 字串)。

> **此層使用真實時鐘,不用 fake timers。** 一旦涉及真的 socket I/O,fake timers 會讓 pending 的 I/O 永遠不 resolve。改以 config 注入極小常數(`CREDIT_PER_TICK_MS=300`、`TOPUP_THRESHOLD_MS=100`、`GRACE_MS=120`),使完整的「付款 → 串流 → 斷流」週期在 1 秒內跑完。這也順帶驗證了參數確實是注入的而非硬編碼。

驗證項目:

- 無 `X-PAYMENT` → 402
- 有效付款 → `onAfterSettle` 觸發、session 建立、body 回 `{ sessionId, accepted: true }`
- `X-PAYMENT-RESPONSE` header 存在且含 `transaction`
- `/stream` 未知 sessionId → 404
- 同一 sessionId 開第二條 SSE → 409
- payer 不符的 tick → 403
- SSE 收到 `event: credit` 且 `remainingMs` 遞減
- 逾期 → 收到 `event: cut` 且連線確實關閉
- agent 主動斷線 → session 自帳本移除,且日誌標示為 agent 端斷線(非 watchdog 剪線)
- 被剪除的 sessionId 再次付款 → 回應帶**不同的**新 sessionId,舊 id 的 `tickCount` 不復活
- `event: credit` 在寬限期內回報負的 `remainingMs` 且 `grace: true`

> **`paymentMiddleware` 的 `syncFacilitatorOnStart` 預設為 `true`**(第 5 個位置參數),啟動時會呼叫 facilitator 的 `/supported`。假 facilitator 必須實作此端點,否則測試中 server 無法啟動。

### 第 3 層 — 鏈上冒煙測試(手動)

`npm run smoke`:對真實 Fuji 跑 3 個 tick,輸出 tx hash。不進 CI,不計入涵蓋率。

### 實作順序

```
0. 量測 spike(拋棄式)→ 定案 §5 參數
1. sessions / usdc / config / sse   純函數,無 I/O
2. watchdog + stream                假 TokenSource,無付款
3. 假 facilitator + 合約測試層        完整流程,不碰鏈
4. 真 x402 middleware + onAfterSettle
5. 真 facilitator + Fuji            冒煙測試
```

付款層放最後:第 1–3 步的每一項都能在不碰鏈的情況下完成驗證。

## 9. 已知風險

| 風險 | 說明 | 應對 |
| --- | --- | --- |
| **settle 耗時決定參數可行性** | settle 位於回應關鍵路徑上(§2.5)。若實測 wall-clock 接近或超過 `TOPUP_THRESHOLD_MS`,補款永遠追不上消耗,demo 會自行斷流 | §8 第 0 步的量測 spike 先於一切實作;`TOPUP_THRESHOLD_MS` 必須大於實測值 |
| facilitator EOA nonce 排隊 | 高頻 settle 時 facilitator signer 使用 sequential nonce,連續結算可能排隊或衝突 | spike 階段即可觀察;若發生,加大 `CREDIT_PER_TICK_MS` 降低頻率 |
| 套件已發佈版本與 `main` branch 不一致 | `DEFAULT_ASSETS` / `DEFAULT_STABLECOINS` 的命名與內容在兩者間不同(§3.3) | 版本鎖 `2.25.0`;所有行為判斷以安裝的 dist 為準,不看 GitHub 原始碼 |
| 第三方文件版本落後 | 多數 x402 教學仍為 v1 寫法 | 一律以 `coinbase/x402` repo 的 v2 範例與實際 dist 為準 |
| facilitator gas 耗盡 | 自架需自行維護 AVAX 餘額 | 錯誤訊息明確指向此原因(見 §7) |
| EIP-3009 路徑出狀況 | 主要 transfer method 依賴 Fuji USDC 的 `transferWithAuthorization` | permit2 為可用備援,但**有前置條件**,見 §9.1 |
| hook 拋錯導致付款已結算但 session 未建立 | 見 §2.5 殘留風險 | PoC 接受;agent 重試一次後明確報錯 |
| `/stream` 的 bearer sessionId | 授權 = 持有 token(UUID,不可列舉);持有者可佔據唯一連線至額度到期,但無法延長(payer 綁定擋住) | PoC 接受。傳輸採 `X-Drip-Session` header 而非 query string,消除 proxy/access-log 洩漏面;威脅模型為本機/測試網 |

### 9.1 permit2 備援的前置條件

`@x402/evm` 的 exact scheme 有兩條 transfer method:`eip3009`(預設)與 `permit2`。本專案走 `eip3009`,但若該路徑出狀況,permit2 在 Fuji 上是可用的備援 —— **不過它不是改個設定就能切換**。

已實測確認的部署狀況(Fuji,`eth_getCode`):

| 合約 | 位址 | bytecode |
| --- | --- | --- |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | 9152 bytes |
| x402ExactPermit2Proxy | `0x402085c248EeA27D92E8b30b2C58ed07f9E20001` | 2913 bytes |

> proxy 位址在 `@x402/evm@2.25.0` 中是**單一字串常數** `x402ExactPermit2ProxyAddress`,而非 per-chain 對照表 —— 屬確定性部署,各鏈同址。

**前置條件:付款者錢包必須先對該 token 做一次性的鏈上 `approve` 給 Permit2 合約**,之後才能以鏈下簽名授權個別轉帳。函式庫的 API 形狀直接說明了這一點:

```ts
// createPermit2ApprovalTx(tokenAddress) → { to, data },由呼叫端自行送出交易
const tx = createPermit2ApprovalTx("0x...");
await walletClient.sendTransaction({ to: tx.to, data: tx.data });
```

由此推出兩個影響:

- **不影響 §2.5 的 settle 延遲分析。** 這筆 approve 是一次性的,不進每個 tick 的熱路徑。
- **但 agent 錢包會需要 AVAX。** 走 `eip3009` 時 agent 完全不需要 AVAX(gas 是 facilitator 的事),這是 §7 目前沒有「agent AVAX 不足」那一列的原因。**一旦啟用 permit2 備援,該列就必須補上**,且 §1 的快速開始要多一個「agent 錢包領 AVAX」的步驟。

## 10. 驗收標準

1. `docker compose up` 起得了 facilitator,`/health` 回應正常
2. `npm run server` 起得了賣方 server;facilitator 未啟動時拒絕啟動並給出明確訊息
3. `npm run agent` 後,終端可見:每個 tick 的付款、自 `X-PAYMENT-RESPONSE` 讀出的 tx hash、累計花費(USDC)、以及持續流動的 token
4. 第一次 Ctrl-C 後,agent 停止付款但保持連線,token 繼續流動數秒
5. 經過「停付當下餘額 + `GRACE_MS`」後(以暫定參數為 4～7 秒,實際值依 §8 spike 定案),server 主動切斷,agent 端顯示連線已被 server 關閉,server 端顯示 `✂ 切斷串流` 且標示為 watchdog 剪線而非 agent 斷線
6. 將 `MAX_SPEND_ATOMIC` 調低後,agent 撞到上限自動停付,產生相同的斷流結果
7. 單元測試與合約測試通過,涵蓋率 ≥ 80%
8. §8 第 0 步的 spike 已執行,§5 參數已依實測值定案(或確認暫定值可行)
