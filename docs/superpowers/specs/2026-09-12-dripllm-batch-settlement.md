# DripLLM — Payment Channel(batch-settlement)設計文件

> 把「一格 25 秒、每格一筆鏈上交易」改成「一格 1 秒、每格一張鏈下 voucher」。
>
> 銜接 [2026-09-06 設計文件](2026-09-06-dripllm-design.md),以下以「原 spec」稱之。未提及的部分沿用原 spec。

---

## 1. 目標

### 1.1 要解決的問題

原 spec 的參數(一格 25 秒、補款門檻 15 秒、停付到剪線 2～27 秒)不是設計偏好,是被鏈上結算的耗時逼出來的。2026-09-11 拆解量測(5 個 tick,server 與 facilitator 之間插計時 proxy,對照區塊的 `timestampMilliseconds`):

| 區段 | 耗時 | 佔比 |
| --- | --- | --- |
| 402 challenge + 簽章 + handler | 13～54ms | < 1% |
| verify | 0.5～0.7s(冷啟動首次 5.8s) | ~7% |
| settle:收到請求 → 出塊 | 0.95～1.02s | ~13% |
| settle:出塊 → facilitator 回應 | 5.3～7.4s | ~80% |
| **整個 tick** | **6.9～8.1s** | |

最後一段的成因已定位:x402-rs 的 `crates/chains/x402-chain-eip155/src/chain/provider.rs` 以 `RpcClient::new(fallback, false)` 建立 client,`is_local` 寫死為 `false`,alloy 因此採用 7000ms 的預設輪詢間隔(本機才是 250ms),而 receipt 是經 `pending_tx.get_receipt()` 等待的。設定檔沒有可調的選項,EVM 傳輸層也只接受 http/https(WebSocket 會被 filter 掉)。

**兩個結論:**

1. 鏈不是瓶頸。出塊只花約 1 秒,符合 Snowman 的確定性水準。
2. 即使把輪詢修好,settle 仍有約 1.5 秒的下限(出塊 1 秒 + 輪詢 + RTT),再加上「補款門檻必須大於 settle」的約束,一格最少也要 5 秒上下。**per-tick 上鏈這條路到不了 1 秒級。**

另有一項經濟面的理由:一筆 settle 實測用掉 85,720 gas。Fuji 測試網當下的 base fee 近乎為零(單筆約 `1.4e-11` AVAX),但主網若在 1～25 nAVAX,同一筆約 0.0001～0.002 AVAX —— 與一格 0.001 USDC 的收入同量級甚至更貴。**每格上鏈在主網不成立。**

### 1.2 這份文件要達成的

- 一格 = **1 秒**,每格的付款是一張**鏈下簽名的累計 voucher**,毫秒級、不花 gas
- 停付到剪線縮到**約 1.35 秒**(一格 + watchdog sweep + 寬限)
- 上鏈次數從「每 25 秒一筆」降到「開場一筆 + 賣方定期批次請款」
- 買方單筆曝險從 25 秒份縮到 1 秒份

### 1.3 非目標

- 不改 SSE 串流與剪線的既有架構(原 spec §2.1、§2.4、§6.3 全部沿用)
- 不接真實 LLM(仍是罐頭 `TokenSource`)
- 不上主網
- 不自己寫智能合約(用 x402 已部署的 batch-settlement 合約)
- 不做多買方規模化,但 channel 儲存必須可持久化(§2.5)

---

## 2. 核心設計決策

### 2.1 一格一秒,付款改為鏈下 voucher

| 方案 | 一格下限 | 上鏈頻率 | 為什麼不採用 |
| --- | --- | --- | --- |
| 現況 `exact` + 修好 x402-rs 輪詢 | ~5s | 每格一筆 | 到不了 1 秒級;主網 gas 比收入貴 |
| `upto` scheme | 同上 | 每格一筆 | 走 Permit2,agent 需先做一次鏈上 approve,還得備 AVAX |
| **`batch-settlement`(採用)** | **1s 或更短** | 開場 1 筆 + 定期批次 | — |

`batch-settlement` 是 payment channel:買方先把押金存進合約,之後每次請求只簽一張「累計上限」voucher 交給賣方,賣方定期把最新一張拿去鏈上請款。**因為 voucher 記的是累計金額,1000 格只要提交最後一張,gas 與 1 格相同。**

### 2.2 端點與 SSE 完全不變

`POST /tick`、`GET /stream`、`GET /health` 三個端點、`X-Drip-Session` header、SSE 的 `token`/`credit`/`cut` 三種事件全部不動。改的只有 x402 middleware 掛的 scheme,以及一格買到多少時間。

理由:原 spec §2.2 的分工(只有 `/tick` 收費、session 只在付款成功後存在)與付款 scheme 正交。維持不變可以讓這次改動的 diff 集中在收費層。

### 2.3 Channel 生命週期

```
① deposit   買方        押金進合約 + 第一張 voucher     上鏈(facilitator 送)
② voucher   買方 每格   累計上限 +1 格,簽章交給賣方     鏈下(毫秒)
③ claim     賣方 定期   提交最新 voucher,記入 totalClaimed  上鏈
④ settle    賣方 定期   把已 claim 的餘額轉給收款地址     上鏈
⑤ refund    結束時      未用完的押金退回買方             上鏈
```

②之外全部不在熱路徑上。③④由 `BatchSettlementChannelManager` 依政策執行,與買方的請求節奏無關。

### 2.4 voucher 的上限每格只加一格(關鍵決策)

voucher 上有兩個不同的數字,混淆會直接造成資損:

| 欄位 | 誰簽 | 意義 |
| --- | --- | --- |
| `maxClaimableAmount` | 買方(`payerAuthorizer`) | 累計**上限** —— 授權賣方最多可領到這個數字 |
| `chargedCumulativeAmount` | 賣方本地帳本 | 已提供服務、累計應收金額 |
| `totalClaimed` | 賣方(`receiverAuthorizer`) | 已透過最新 voucher 上鏈 claim 的累計金額 |

合約只保證「不超過買方簽的上限」,**不保證「等於實際服務量」**。因此:

> **買方的曝險 = 已簽的上限,不是已消耗的量。**

所以 client 端的策略必須是:**每格重簽一次,上限 = 已消耗 + 1 格**。任何「一次簽一個大上限以節省簽章」的做法都等於把整筆押金交給賣方自律,正是本專案要避免的取捨。簽章是鏈下的、毫秒級、免 gas,每格簽一次沒有成本問題。

這條規則同時撐住了 demo 的核心性質:**停付 = 不再簽新 voucher = 額度不再延長 = 被剪線。**

### 2.5 賣方必須自己守的三條規則

協議不會幫賣方擋下面三件事,全部要在 server 端實作:

1. **押金餘額守門。** voucher 的上限可以簽得比 channel 餘額高,但 claim 時領不到。送出任何 token 之前必須確認 `chargedCumulativeAmount + 本次要收的金額 ≤ balance`。`totalClaimed` 只用來計算尚未上鏈 claim 的應收款(`chargedCumulativeAmount − totalClaimed`),claim 成功不會恢復可服務額度。這是唯一真正的賣方資損路徑,必須是純函數並被測到底(§6.2)。
2. **claim 時效。** 買方可發起提領,`withdrawRequestedAt` 記在 channel 上,經過 `withdrawDelay` 秒後就能把押金領走。賣方必須在這段延遲內把最新 voucher claim 上鏈,因此 `getWithdrawalPendingSessions()` 要接進監控並觸發立即 claim。
3. **狀態持久化。** 最新那張 voucher 的簽章只存在賣方手上,server 重啟就等於放棄那段收入。`InMemoryChannelStorage` 只可用於測試,實跑一律用 file 或 redis storage。

> 第 3 點與原 spec 的 session 帳本只存記憶體是同一類問題,但後果不同:session 掉了只是斷線重來,voucher 掉了是真的收不到錢。

### 2.6 session 與 channel 是兩層,不合併

`sessionId` 仍由 agent 產生(原 spec §2.2.1),`channelId` 則由 `computeChannelId(channelConfig, network)` 從 `ChannelConfig` 推導。兩者一對一但不共用識別字:

- session 管的是「這條 SSE 還能活多久」——`paidUntilMs`、`tickCount`,生命週期是一次串流
- channel 管的是「這個買方的押金還剩多少」——`balance`、`totalClaimed`、`chargedCumulativeAmount`,生命週期跨多次串流

session 被剪除不影響 channel(押金還在,可以再開一條串流);channel 押金耗盡則所有 session 都無法延長。

### 2.7 facilitator 換成自架 TypeScript 版

x402-rs 不支援 batch-settlement(README 連 upto 與 deferred 都標 Planned),因此改用 `@x402/core/facilitator` 的 `x402Facilitator`,註冊 `@x402/evm/batch-settlement/facilitator` 的 scheme。

**注意:`x402Facilitator` 只是一個類別,提供 `verify()`、`settle()`、`getSupported()` 三個方法,不含 HTTP 伺服器。** HTTP 那層要自己寫一支約 60 行的 Express app(§3.3)。

順帶解決原 spec 的 7 秒輪詢問題:自架版由我們自己建 viem client,`pollingInterval` 可以直接設成 250～500ms。**viem 的預設值須在 spike 一併量測確認。**

### 2.8 剪線判定完全不碰鏈

watchdog 的邏輯不變,仍是 `now > paidUntilMs + GRACE_MS`。差別在於 `paidUntilMs` 的延長來自一張鏈下 voucher 的驗證(毫秒),而不是一筆鏈上交易(秒級)。**剪線速度因此不再受鏈的任何性質影響。**

原 spec §2.5「session 的建立與延長發生在 `onAfterSettle`」保留不變。理由從「避免結算延遲侵蝕額度」變成「維持單一入口」——voucher 的 settle 不上鏈,延遲降到毫秒級,但把入口留在同一處可以讓 diff 最小,也保住「只有付款成功才有 session」這條性質。

---

## 3. 技術選型

### 3.1 套件與類別對照

| 角色 | 現況 | 改為 |
| --- | --- | --- |
| server scheme | `@x402/evm/exact/server` 的 `ExactEvmScheme` | `@x402/evm/batch-settlement/server` 的 `BatchSettlementEvmScheme(receiverAddress, { storage, receiverAuthorizerSigner, withdrawDelay })` |
| client scheme | `@x402/evm/exact/client` 的 `ExactEvmScheme` | `@x402/evm/batch-settlement/client` 的 `BatchSettlementEvmScheme`(含 deposit policy)+ `createBatchSettlementClientHooks` |
| 賣方請款 | 無 | `BatchSettlementChannelManager({ scheme, facilitator, receiver, token, network })` |
| facilitator | x402-rs(Docker) | `x402Facilitator` + `@x402/evm/batch-settlement/facilitator` |
| channel 儲存 | 無 | server:`ChannelStorage`(file / redis);client:`ClientChannelStorage` |

client 端已提供的現成能力(不必自己實作):`buildChannelConfig`、`computeChannelId`、`signVoucher`、`createBatchSettlementEIP3009DepositPayload`、`depositAmountForRequest`、`refundChannel`、`recoverChannel`、`processCorrectivePaymentRequired`。

### 3.2 鏈與合約(Fuji,已用 `eth_getCode` 驗證)

| 項目 | 位址 | 狀態 |
| --- | --- | --- |
| BatchSettlement | `0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003` | 已部署(11,175 bytes) |
| ERC3009 Deposit Collector | `0x4020806089470a89826cB9fB1f4059150b550004` | 已部署(1,150 bytes) |
| USDC(Fuji) | `0x5425890298aed601595a70AB815c96711a31Bc65` | 沿用 |

位址來源:`@x402/evm@2.25.0` 的 `dist/cjs/index.js:1644-1645`,是**單一字串常數而非 per-chain 對照表** —— 屬確定性部署,各鏈同址,與原 spec §9.1 對 Permit2 proxy 的觀察一致。

> **驗證程度僅到「該位址上有 bytecode」。** `eth_getCode` 不比對 bytecode 內容,也未實際呼叫過合約,因此尚不能保證版本與套件相符。真正的驗證是 §8 spike 的第 1 項:實際送出一次 deposit 並確認上鏈。

押金走 **ERC-3009**(`receiveWithAuthorization`),因此 **agent 錢包仍然不需要 AVAX**,gas 全由 facilitator 的 signer 支付。這是不選 `upto` 的主因之一(它只支援 Permit2,需要一次鏈上 approve)。

### 3.3 自架 facilitator 的 HTTP 介面

`x402Facilitator` 不含 HTTP 層,需自行提供三個端點,與 x402-rs 相容:

```
POST /verify     → facilitator.verify(paymentPayload, paymentRequirements)
POST /settle     → facilitator.settle(paymentPayload, paymentRequirements)
GET  /supported  → facilitator.getSupported()
GET  /health     → server/main.ts 的啟動檢查沿用
```

組裝形狀(細節以 dist 為準):

```ts
const facilitator = new x402Facilitator()
  .register(FUJI_USDC.network, new BatchSettlementEvmScheme(signer, authorizerSigner, config));
```

facilitator 的 signer 仍需自備 AVAX;它負責送出 deposit / claim / settle / refund 四種交易。

---

## 4. 執行時序

```
agent                         server                     facilitator            Fuji
  │                             │                             │                  │
  ├─ POST /tick ───────────────▶│                             │                  │
  │◀─── 402 + 押金/上限需求 ─────┤ (extra: receiverAuthorizer, withdrawDelay)     │
  │  ① 簽 deposit + 首張 voucher │                             │                  │
  ├─ POST /tick + X-PAYMENT ───▶├─ verify ───────────────────▶│                  │
  │                             ├─ settle ───────────────────▶├─ 押金上鏈 ──────▶│
  │                             │◀──────────────────────── ok ┤                  │
  │                             ├─ hook: 建立 session          │                  │
  │◀── {sessionId, accepted} ───┤   paidUntil = now + TICK_MS  │                  │
  ├─ GET /stream ──────────────▶│                             │                  │
  │◀═══ token / credit ═════════╡                             │                  │
  │                             │                             │                  │
  │  ② 每格:簽 voucher(上限 +1 格)                            │                  │
  ├─ POST /tick + X-PAYMENT ───▶├─ 驗簽 + 守門(§2.5.1)─────▶│ 鏈下,毫秒        │
  │◀═══ token token ════════════╡   paidUntil += TICK_MS       │                  │
  │                             │                             │                  │
  │  ^C 停付(不再簽 voucher)    │                             │                  │
  │◀═══ token ══════════════════╡ 餘額燒完 + GRACE_MS          │                  │
  │◀─── event: cut ─────────────┤ watchdog 剪線(≈1.35s 內)   │                  │
  │                             │                             │                  │
  │                             ├─ ③④ 定期 claim + settle ───▶├─ 上鏈 ──────────▶│
  │                             ├─ ⑤ 閒置時 refund ──────────▶├─ 退還押金 ──────▶│
```

**停付到剪線 = 停付當下的剩餘餘額 + `GRACE_MS` + 最多一個 sweep 週期。** 以 §5 的建議值推算:剩餘餘額 0～1 秒、`GRACE_MS` 250ms、sweep 100ms,**上限約 1.35 秒**(現況為 2～27 秒)。

**首個 token 的延遲不會歸零。** 第一格必須等 deposit 上鏈,估計 1～2 秒(出塊約 1 秒 + 輪詢 250ms + RTT),由 §8 spike 定案。現況為 7～14 秒。

---

## 5. 參數

> **全部為建議起始值,以 §8 的 spike 實測定案。** 標示「待量測」者不得在未實測前寫死。

### 5.1 串流計費

| 參數 | 建議值 | 說明 |
| --- | --- | --- |
| `CREDIT_PER_TICK_MS` | `1000` | 一格買到的串流時間,從 25000 改為 1000 |
| `TOPUP_THRESHOLD_MS` | `300` | 餘額低於此值即簽下一張 voucher(> 簽章 + `/tick` RTT,待量測) |
| `GRACE_MS` | `250` | 從 2000 改為 250 |
| `PRICE_PER_TICK_ATOMIC` | `40` | 0.00004 USDC,維持目前每秒費率(0.001 / 25s) |
| `CREDIT_EVENT_MS` | `250` | 從 500 改為 250,配合一秒一格 |
| `WATCHDOG_SWEEP_MS` | `100` | 從 250 改為 100 |
| `TOKEN_INTERVAL_MS` | `120` | 不變 |
| `TOMBSTONE_TTL_MS` | `60000` | 不變 |
| `MAX_SPEND_ATOMIC` | `50000` | 不變,agent 的花費上限 |

### 5.2 Channel

| 參數 | 建議值 | 說明 |
| --- | --- | --- |
| `DEPOSIT_ATOMIC` | `50000` | 0.05 USDC ≈ 1,250 格 ≈ 21 分鐘 |
| `DEPOSIT_TOPUP_ATOMIC` | `5000` | 押金餘額低於 0.005 USDC(≈125 秒)即補押金 |
| `WITHDRAW_DELAY_SECS` | `900` | 買方非合作提領的等待期;必須 > claim 週期 + 上鏈延遲 + 餘裕 |
| `CLAIM_INTERVAL_SECS` | `60` | 賣方批次請款週期 |
| `SETTLE_INTERVAL_SECS` | `300` | 已請款餘額轉出週期 |
| `REFUND_IDLE_SECS` | `120` | channel 閒置多久後主動退款 |
| `MAX_CLAIMS_PER_BATCH` | `20` | 一筆 claim 交易最多帶幾張 voucher |

### 5.3 必須滿足的約束

```
TOPUP_THRESHOLD_MS   > voucher 簽章 + /tick RTT          (毫秒級,待量測)
CREDIT_PER_TICK_MS   > TOPUP_THRESHOLD_MS                (需有明顯餘裕)
GRACE_MS + WATCHDOG_SWEEP_MS = 停付到剪線的下界
DEPOSIT_TOPUP_ATOMIC > deposit 上鏈 wall-clock × 每秒費率  (待量測)
WITHDRAW_DELAY_SECS  > CLAIM_INTERVAL_SECS + 上鏈延遲 + 餘裕
```

### 5.4 曝險對照

| | 現況(exact) | 本設計(batch-settlement) |
| --- | --- | --- |
| 買方單筆曝險 | 一格 25 秒份(0.001 USDC) | 一格 1 秒份(0.00004 USDC) |
| 買方額外曝險 | 無 | 押金鎖定,最壞需等 `WITHDRAW_DELAY_SECS` 才能非合作取回 |
| 賣方即時曝險 | 寬限 2 秒 | 一格 + sweep ≈ 1.1 秒 |
| 賣方新增責任 | 無 | 押金守門、claim 時效、voucher 持久化 |
| 停付到剪線 | 2～27 秒 | ≈1.35 秒 |
| 首個 token 延遲 | 7～14 秒 | 1～2 秒(待量測) |
| 上鏈次數 | 每 25 秒一筆 | 開場 1 筆 + 每 60 秒一筆 + 收工 refund |

---

## 6. 元件與檔案結構

```
src/
├── config.ts                    ✏️ 新增 §5.2 全部參數
├── shared/
│   └── usdc.ts                  ✏️ 新增 batch-settlement 合約位址
├── facilitator/                 🆕 自架 TS facilitator
│   └── main.ts                     x402Facilitator + 四個端點(§3.3)
├── server/
│   ├── payment.ts               ✏️ 換 scheme,注入 storage 與 receiverAuthorizerSigner
│   ├── channels.ts              🆕 押金守門與餘額換算(純函數,§6.2)
│   ├── channelStorage.ts        🆕 file / redis storage 選擇
│   ├── claimJob.ts              🆕 ChannelManager 組裝與政策(§6.3)
│   ├── settleHook.ts            ✏️ 沿用,改吃 voucher 結算結果
│   ├── sessions.ts              — 不變
│   ├── registry.ts              — 不變
│   ├── watchdog.ts              — 不變
│   ├── stream.ts                — 不變
│   └── tokenSource.ts           — 不變
└── agent/
    ├── wallet.ts                ✏️ 換 client scheme + deposit policy + client hooks
    ├── heartbeat.ts             — 幾乎不變(仍 POST /tick)
    ├── ledger.ts                — 不變
    ├── sse.ts / render.ts       ✏️ render 顯示押金餘額與已簽上限
    └── main.ts                  ✏️ 收工時觸發 refund
```

`docker-compose.yml` 的 x402-rs 服務移除,改為 `npm run facilitator`(或另建本地 image)。

### 6.1 Channel 帳本(來自套件,不自己定義)

```ts
interface Channel {
  channelId: string;
  channelConfig: ChannelConfig;      // payer, payerAuthorizer, receiver, receiverAuthorizer,
                                     // token, withdrawDelay, salt
  chargedCumulativeAmount: string;   // 賣方記的實際消耗
  signedMaxClaimable: string;        // 買方簽的上限
  signature: string;                 // 最新一張 voucher 的簽章 —— 掉了就收不到錢
  balance: string;
  totalClaimed: string;
  withdrawRequestedAt: number;
  lastRequestTimestamp: number;
}
```

`ChannelStorage.updateChannel()` 要求「讀取與寫入之間不可有並行插入」。`InMemoryChannelStorage` 只在單一 JS runtime 內成立,多實例部署需要 Redis Lua 或 SQL transaction 等後端層級的原子條件更新。**PoC 單實例,但一律使用可持久化的 storage(§2.5.3)。**

### 6.2 賣方守門(純函數,涵蓋率主力)

```ts
canServe(channel, priceAtomic): boolean          // chargedCumulativeAmount + priceAtomic ≤ balance
remainingTicks(channel, priceAtomic): number     // floor((balance − chargedCumulativeAmount) / priceAtomic),最小為 0
needsDepositTopUp(channel, thresholdAtomic): boolean
withdrawDeadlineMs(channel, withdrawDelaySecs): number | null  // 未申請提領時為 null
```

全部接受 `nowMs` 由呼叫端傳入,不呼叫 `Date.now()` —— 與原 spec §6.1 同一原則,才能用假時鐘測邊界。

### 6.3 claim 政策

```ts
manager.start({
  claimIntervalSecs: config.claimIntervalSecs,
  settleIntervalSecs: config.settleIntervalSecs,
  refundIntervalSecs: config.refundIntervalSecs,
  maxClaimsPerBatch: config.maxClaimsPerBatch,
  shouldSettle: (ctx) => ...,          // 未請款金額超過門檻才轉出,省 gas
  selectClaimChannels: (channels) => ...,  // 提領申請中的 channel 優先
  onError: (e) => logger.error("claim", ...),
});
```

**提領申請必須插隊。** `getWithdrawalPendingSessions()` 回傳的 channel 要立即 claim,不能等下一個 `claimIntervalSecs`。這是 §2.5.2 的實作點。

---

## 7. 錯誤處理

| 情境 | 行為 |
| --- | --- |
| 押金不足以支付下一格 | server 不送 token,回 402 並帶 channel 狀態;agent 補押金後重試 |
| 累計基準失步(client 與 server 對不上) | server 回 corrective 402 帶 `channelState` / `voucherState`;client 以 `processCorrectivePaymentRequired()` 驗證後重簽 |
| voucher 簽章無效 / 上限未遞增 | 拒絕該格,不延長 `paidUntil`,由 watchdog 自然剪線 |
| 買方申請提領 | 立即 claim;claim 成功後照常服務至押金耗盡 |
| deposit 上鏈失敗 | agent 收到明確錯誤;無 session 建立,無資損 |
| claim 上鏈失敗 | 記錄並在下一週期重試;超過 `WITHDRAW_DELAY` 仍失敗則為資損,必須告警 |
| facilitator 無回應 | server 啟動時拒絕啟動(沿用原 spec);運行中則 deposit/claim 失敗,voucher 驗證不受影響 |
| server 重啟 | channel 從持久化 storage 復原;session 全數消失,agent 重新開串流 |

---

## 8. 測試策略與實作順序

沿用原 spec 的三層架構與 80% 涵蓋率門檻。

### 第 0 步 — 量測 spike(先於一切實作)

與原 spec 同樣的紀律:**產出是四個數字,不是要保留的程式碼。**

1. deposit 上鏈 wall-clock(決定 `DEPOSIT_TOPUP_ATOMIC` 與首個 token 延遲)
2. 單格 voucher 的 `/tick` wall-clock(決定 `TOPUP_THRESHOLD_MS`,預期毫秒級)
3. claim 上鏈 wall-clock 與 gas
4. viem client 的 `pollingInterval` 預設值,以及設為 250ms 後的 deposit 延遲差異

第 2 項若未達毫秒級,`CREDIT_PER_TICK_MS = 1000` 就不成立,必須回頭重估。

### 第 1 層 — 純函數單元測試

`channels.ts` 全部(§6.2)、claim 政策的選擇函式、`sessions.ts` 既有測試沿用。假時鐘,不碰網路。押金守門必須有以下 regression cases:

- 未 claim 的已提供服務仍會佔用押金
- claim 成功不會恢復可服務額度
- 剩餘額度剛好等於一格時允許,少 1 atomic 時拒絕
- top-up 增加 `balance` 後才恢復可服務額度
- `remainingTicks` 向下取整,且 `totalClaimed` 變動不影響結果
- 帳本不一致而使 `chargedCumulativeAmount > balance` 時,剩餘格數最小為 0

### 第 2 層 — HTTP 合約測試(不碰鏈)

搭假 facilitator(沿用 `tests/helpers/fakeFacilitator.ts` 擴充 batch-settlement 的 payload 型別):

- 押金足夠 → 每格延長 `paidUntil`
- 押金耗盡 → 402 且不送 token
- 上限未遞增 / 簽章錯誤 → 拒絕
- 停付 → `GRACE_MS + WATCHDOG_SWEEP_MS` 內收到 `event: cut`
- server 重啟後 channel 從 storage 復原

### 第 3 層 — 鏈上冒煙測試(手動,不進 CI)

`npm run smoke:channel`:deposit → 10 格 voucher → claim → refund,輸出各階段 tx hash 與 gas。

### 實作順序

1. spike(第 0 步)
2. `channels.ts` 純函數 + 測試
3. 自架 facilitator(`src/facilitator/main.ts`)+ `/supported` 對接
4. server 收費層換 scheme + storage
5. agent 端 client scheme + deposit policy
6. claim / refund 排程
7. 參數調校與 demo 節奏

---

## 9. 已知風險

| 風險 | 說明 | 應對 |
| --- | --- | --- |
| **voucher 簽章遺失** | 賣方 storage 損毀 = 該段服務收不到錢 | 一律用持久化 storage;claim 週期不宜過長 |
| **提領競賽** | 沒在 `withdrawDelay` 內 claim 就拿不到 | 提領申請插隊 claim + 告警;`WITHDRAW_DELAY_SECS` 留足餘裕 |
| **上限簽過頭** | client 若一次簽大上限,買方曝險等於該上限 | 每格只加一格(§2.4),並在合約測試中驗證遞增量 |
| **押金守門漏洞** | 服務量超過押金 = 賣方資損 | `canServe()` 為純函數且必測;送 token 前一律檢查 |
| **自架 facilitator 無現成 HTTP 層** | 需自己寫,錯誤處理與 x402-rs 不一定一致 | 以 x402-rs 的 `/verify` `/settle` `/supported` 回應形狀為準,合約測試對齊 |
| **失去 x402-rs 的成熟度** | 換成自寫 60 行的 Express app | 只在 PoC 範圍;facilitator 僅供本機 demo |
| **多實例的原子性** | `InMemoryChannelStorage` 只保證單 runtime | PoC 單實例;文件註明多實例需 Redis Lua / SQL transaction |
| **每格一次 HTTP 往返** | 一秒一格 = 每秒一次 `POST /tick` | 本機 RTT 5.5ms,可接受;若改遠端需重估 |
| **合約風險** | 押金鎖在第三方合約 | 僅測試網、僅小額(0.05 USDC) |

---

## 10. 驗收標準

1. `npm run facilitator` 起得了自架 facilitator,`/health` 與 `/supported` 回應正常
2. `npm run server` 在 facilitator 未啟動時拒絕啟動並給出明確訊息(沿用原行為)
3. `npm run agent` 後:第一格完成 deposit 並在 **2 秒內**開始串流(spike 定案後填入實測值)
4. 穩定串流時,每秒一格,終端可見已簽上限、押金餘額、累計消耗
5. 第一次 Ctrl-C 後停止簽 voucher 但保持連線,**1.5 秒內**收到 `event: cut` 並由 server 關閉連線
6. 把 `DEPOSIT_ATOMIC` 調低,押金耗盡後產生相同的斷流結果
7. 收工後 refund 成功,未用完的押金回到買方錢包(鏈上可驗)
8. **上鏈次數與格數脫鉤(本設計的核心性質)。** 把 `CREDIT_PER_TICK_MS` 減半(格數加倍、串流時長不變)後重跑,鏈上交易數**不得改變**。

   交易數只由時長與 §6.3 的政策決定:deposit 0～1 筆(channel 已存在且餘額足夠時為 0)、claim `⌈時長 ÷ CLAIM_INTERVAL_SECS⌉` 筆、settle `⌈時長 ÷ SETTLE_INTERVAL_SECS⌉` 筆、收工 refund 0～1 筆。refund 會夾帶尚未 claim 的 voucher,因此最後一次 claim 可與 refund 合併。若把 claim 改為閒置觸發,一場串流可壓到 **3 筆**(deposit + refund 含 claim + settle)。
9. 單元測試與合約測試通過,涵蓋率 ≥ 80%

---

## 11. 待定事項

- **每格價格。** `40` atomic 只是沿用現行每秒費率的換算結果。若之後貼近真實 GPU 成本(例如 $1/小時 ≈ 278 atomic/秒),整組押金參數要重算。
- **`WITHDRAW_DELAY_SECS = 900` 的取捨。** 對買方是資金鎖定上限,對賣方是 claim 的安全邊際。兩邊都合理的值需要在有真實使用情境後再定。
- **claim 是否改為「未請款金額超過門檻」而非固定週期。** gas 便宜時固定週期較單純,主網則應以金額門檻為主。
- **agent 是否需要在 `MAX_SPEND_ATOMIC` 與押金之間二選一。** 目前兩者並存,語意重疊(押金本身就是硬上限)。

---

## 12. 實作偏離紀錄

實作過程中與本文件不一致、但經判斷後保留的決定。每一條都寫明原因,避免日後被當成 bug 修掉。

### 12.1 `GET /tick` 是新增的端點(§2.2 的例外)

§2.2 寫「端點與 SSE 完全不變」,實際多了一條 `GET /tick`。

`@x402/evm` 的 cooperative refund(`refundChannel`)會先對資源 URL 發一次 **GET** probe 取得
`PaymentRequirements`,再用其中的 `channelConfig` 組退款 payload。若只註冊 `POST /tick`,
這次 probe 拿不到 402,退款就無法發起(§10.7 直接不成立)。

因此 `POST /tick` 與 `GET /tick` 掛同一份 `tickResource`。`GET /tick` 只用來回 402,
沒有對應的 Express handler —— 付款成功的 GET 會落到 404,這是預期行為,不是遺漏。

### 12.2 `receiverAuthorizerSigner` 改為選填

§3.1 把 `receiverAuthorizerSigner` 列為 server scheme 的建構參數。實作改為**選填**:

| `LLM_PROVIDER_AUTHORIZER_PRIVATE_KEY` | 誰簽 claim / refund 授權 |
| --- | --- |
| 有設 | 賣方自己(符合 §2.4「`totalClaimed` 由賣方簽」) |
| 留空 | 委派 facilitator,由它在 `/supported` 廣告 `receiverAuthorizer` |

兩種都是套件原生支援的模式,`validateFacilitatorSupport()` 會在「沒設私鑰、facilitator 也沒廣告」
時擋下啟動。做成選填是因為前者要求賣方多管一把私鑰,而 PoC 的 facilitator 本來就是自架的;
**正式環境應由賣方持有**,信任模型才與 §2.4 一致。

### 12.3 新增 `WITHDRAW_POLL_MS`(§5.2 的補充)

§6.3 要求提領申請必須插隊 claim,但沒有定義輪詢頻率。初版借用了 `WATCHDOG_SWEEP_MS`(100ms),
而每次輪詢都會 `readdir` 整個 channel storage 並逐檔讀取 —— 在 `WITHDRAW_DELAY_SECS = 900`
的情況下,這比需要的密了四個數量級。改為獨立參數,預設 5000ms,並由 zod 約束
`WITHDRAW_POLL_MS < WITHDRAW_DELAY_SECS`。

### 12.4 §8 第 0 步的 spike 實測結果(2026-09-20)

Fuji 實跑兩輪,`npm run smoke:channel`,`FACILITATOR_POLLING_MS=250`:

| 量測項 | 第 1 輪 | 第 2 輪 |
| --- | --- | --- |
| ① deposit 上鏈 wall-clock | 5,581ms | 6,902ms |
| ② 單格 voucher `/tick` wall-clock | 8～16ms | 7～14ms |
| ③ claim 上鏈 wall-clock | 3,774ms | 3,822ms |
| deposit gas | 160,492 | 139,524 |
| claim gas(1 張 voucher,涵蓋 11 格) | 74,876 | 57,776 |
| refund wall-clock | 5,059ms(賣方端) | 4,457ms(買方端) |

④ viem 對 Fuji 的預設 `pollingInterval` 是 **2000ms**(`avalancheFuji` 沒有 `blockTime`,
viem 退回 4000ms 的預設區塊時間再取一半,夾在 500～4000ms 之間)。本專案設為 250ms。

**結論一:§2.1 的核心主張成立,而且餘裕比預期大。** 單格 voucher 是 **7～16ms**,
比原本 per-tick 上鏈的 6.9～8.1 秒快約 500 倍。`CREDIT_PER_TICK_MS = 1000` 完全站得住,
`TOPUP_THRESHOLD_MS = 300` 對 16ms 的 RTT 有近 20 倍餘裕 —— §5.3 的第一條約束確認滿足。

**結論二:§10.3 的「2 秒內開始串流」不成立,必須改寫。** deposit 實測 **5.6～6.9 秒**,
遠高於 §4 估的 1～2 秒。兩輪的數字接近,第二輪還更慢,所以這不是冷啟動造成的。
把 x402-rs 的 7000ms 輪詢換成自架版的 250ms 確實有效(整條 settle 從 6.9～8.1 秒降到約 3.8 秒,
見 claim 的數字),但 deposit 這條路另外還有約 3 秒的成本 —— ERC-3009 的 deposit 要做的事
比單純轉帳多(gas 139k～160k,對照 claim 的 58k～75k)。

因此 §5.4 的「首個 token 延遲 7～14 秒 → 1～2 秒」應修正為 **→ 約 6～7 秒**,
而 §10.3 的門檻應改為 **8 秒內**。這不影響本設計的主張:**要證明的量是停付到剪線的曝險窗口,
不是首個 token 的延遲**,而前者已經與鏈完全脫鉤。

### 12.5 facilitator 的 `/supported` 曾回傳 `signers: [null]`

`toFacilitatorEvmSigner()` 的 `getAddresses()` 讀的是**扁平的 `client.address`**,
而 viem 的 `WalletClient` 只有 `client.account.address`。少了那個欄位,`/supported` 會回
`{"signers":{"eip155:*":[null]}}`,resource server 在啟動同步時判定整份 payload 無效,
**所有付款變成 502**。

這個 bug 只會在真的把自架 facilitator 接上 resource server 時出現 —— 單元測試若用
手寫的 `getSupported` 替身就完全看不到。現已在 `src/facilitator/facilitator.ts` 明確補上
`address`,並由 `tests/facilitator.test.ts` 對**真正組起來的** `x402Facilitator` 斷言
signers 必須是真位址。

### 12.6 賣方端退款會讓買方的本地紀錄永久失效

`REFUND_IDLE_SECS` 觸發的賣方端退款(§5.2、§6.3)**不會通知買方**。退款後鏈上餘額歸零、
server 的 channel 紀錄被刪除,但買方本地仍存著「餘額還有 50000」的紀錄,於是繼續簽 voucher-only
的付款,每次都被擋在 `cumulative_exceeds_balance`。

套件的 corrective 復原幫不上忙 —— `processCorrectivePaymentRequired()` 只認
`cumulative_amount_mismatch` 與 `cumulative_amount_below_claimed` 兩種錯誤碼,
`cumulative_exceeds_balance` 不在其中。實測結果是**買方永久卡在 402,除非有人手動刪掉
本地的 channel 檔**。

兩處修正:

1. `src/agent/wallet.ts` 的 client signer 改用 `toClientEvmSigner(account, publicClient)`。
   原本只給裸的 `privateKeyToAccount()`,沒有 `readContract`,而 `recoverChannel()` 明文要求它 ——
   等於鏈上復原這條路從一開始就不通。
2. `payTick()` 收到 `cumulative_exceeds_balance` 時丟棄本地 channel 紀錄並重試一次,
   讓 `recoverChannel()` 從鏈上重建;第二次仍失敗才視為真的沒押金,並給出指向押金而非 faucet 的訊息。

已在 Fuji 實測驗證:故意用賣方端退款製造失步後,下一格會自動重新 deposit 並成功
(修正前是永久 402)。

> 順帶修掉一個會誤導人的啟發式:原本的 `/insufficient|balance|funds/i` 會把 channel 的
> `cumulative_exceeds_balance` 判成「USDC 餘額不足,請去 faucet 領錢」,而錢包其實有 19.97 USDC。
