# DripLLM

> 讓沒有計費基礎設施的小型推論供應商,能對機器客戶按秒收費 —— 持續付費才有推論,停付就被剪線。

DripLLM 是一個最小可跑專案。買方 agent 掛在一條 SSE 串流上,每一筆 USDC 微支付買到一段串流時間,餘額將盡時自動補款;一旦停止付款,餘額燒完加上寬限期,賣方 server 主動切斷連線。付款透過 [x402](https://x402.org) 協議完成,鏈上驗證與結算交給自架的 facilitator 在 Avalanche Fuji 測試網執行。

## 要解決的問題

小型 LLM 供應商想收費,得先自己建一整套東西:帳號系統、金流串接、發票、授信與催收、退款爭議、防詐。**這套成本與客戶數無關,是固定門檻** —— 大公司攤得掉,一個人跑自架模型的攤不掉。

走這條路,供應商只需要一個收款地址加一段 middleware。沒有帳號、沒有發票、沒有授信風險、沒有 chargeback,第一天就是全球的。

### 為什麼按秒,不按 token

按 token 計費是大公司在抽象掉硬體之後的定價方式。**小型自架供應商的真實成本是 GPU 被佔用的時間** —— 一個人跑一張卡,成本就是秒數。按時間計費對這個受眾比按 token 更貼合成本結構。

### 為什麼不能只用原生的 per-request x402

一般的 request/response API,per-request 付款本來就夠了:沒付錢就 402,拿不到回應,曝險等於零。**那種場景這個專案沒有加分。**

沒有現成答案的是**串流** —— 一段跑好幾分鐘的推論,「一次請求」不是自然的計費單位,於是只剩兩個爛選擇:

| 做法 | 誰承擔風險 |
| --- | --- |
| 整段預收 | 買方承擔對手方風險(付了錢對方跑掉) |
| 先給後收 | 賣方承擔授信風險(送完了對方不付) |

第三條路:**把時間切成一格一格,任一方對另一方的曝險都不超過一格。**

### 這個 demo 證明的不是「能不能斷」

「沒錢就沒服務」是所有計費模型的共同點。有意義的量只有一個:**從停止付款到服務真的停下來,曝險窗口有多大。**

以 session 預先授權為基礎的 agent 錢包走的是相反的取捨 —— 先核准一筆預算與時限,agent 在框內自主花費,換取不必每次再問的便利;代價是撤銷之前,整筆預算的曝險實際存在。兩者解的是不同層:**session 授權管「買方能不能花」,DripLLM 管「賣方在對方停付時能多快收手」。**

### 一個硬邊界

門檻沒有消失,是**換邊**了:供應商不必再建計費系統,但每個客戶都得有一個裝了 USDC 的錢包。對人類客戶這是死穴;對 agent 客戶不是 —— agent 本來就是被程式佈建出來的。所以這個題目屬於 agent payment,而不是一般的 SaaS 計費。

## 運作原理

一次 tick 的資料流:

1. agent 送出 `POST /tick`,沒帶付款 → server 回 `HTTP 402` 附上價格、收款資產、`receiverAuthorizer` 與 `withdrawDelay`
2. **第一格**:agent 簽一張 ERC-3009 授權把押金存進 payment channel 合約,並附上第一張累計 voucher,塞進 `X-PAYMENT` header 重送。facilitator 代送上鏈(gas 由它付,agent 不需要 AVAX)
3. **之後每一格**:agent 只簽一張**鏈下** voucher —— 上限 = 已消耗 + 一格。不上鏈、不花 gas、毫秒級
4. settle 成功後,server 在 `onAfterSettle` hook 中建立或延長 session;`/tick` 回 `{ sessionId, accepted: true }`,channel 狀態走 `X-PAYMENT-RESPONSE` header
5. agent 用該 sessionId 開一條 `GET /stream` 的 SSE 連線,token 開始流動
6. 餘額低於門檻時,agent 自動再送一筆 `POST /tick` 把 `paidUntil` 往後延
7. 賣方在熱路徑外**定期**把最新一張 voucher 拿去鏈上 claim,並把已請款餘額 settle 給收款地址;收工時退還未用完的押金

**上鏈次數與格數脫鉤:** voucher 記的是**累計上限**,所以 1000 格只要提交最後一張,gas 與 1 格相同。一場串流的鏈上交易只有「開場押金 + 定期 claim/settle + 收工退款」。

**核心機制:** server 的 watchdog 定期掃描 session 帳本,逾期又超過寬限的 session 會收到 `event: cut`,連線隨即被 server 關閉。

### 為什麼是 SSE 長連線

如果每個 tick 都是一個獨立 request,「斷流」不過是 agent 自己 break 掉迴圈 —— 畫面上分辨不出 server 強制與 agent 自願停止,server 從頭到尾沒行使任何權力。

改成長連線後,agent 還連著、還想要,線卻被剪了。強制力因此是看得見的,Ctrl-C 也才能當作 demo 的觸發鍵。

### 三個端點,只有一個收費

| 端點 | x402 | 職責 |
| --- | --- | --- |
| `POST /tick` | 收費 | 付一筆 → 建立或延長 session |
| `GET /stream` | 免費 | SSE,session 活著就吐 token(sessionId 走 `X-Drip-Session` header) |
| `GET /health` | 免費 | 啟動檢查與 demo 腳本 |

`/stream` 免費不構成漏洞:**session 只有付過錢才存在**,不存在拿到免費 token 的路徑。這讓 x402 middleware 留在它天生擅長的 per-request 位置,SSE 那條完全不碰付款邏輯。

## 架構

```
   buyer agent                    seller server                    facilitator
      │  ──── POST /tick(押金+券)──▶ │  ─── verify / settle ─────────▶ │ ──▶ Fuji:押金進合約
      │  ◀─── {sessionId, accepted} ──┤                                 │
      │  ──── GET /stream ──────────▶ │
      │  ◀═══ token token token ══════╡   watchdog: now > paidUntil + grace
      │  ──── POST /tick(只有券)───▶ │   鏈下驗簽,毫秒級,不碰鏈
      │  ◀─── event: cut ─────────────┤   ✂ server 剪線
      │                               │  ─── 定期 claim / settle ─────▶ │ ──▶ Fuji:賣方請款
      │                               │  ─── 收工 refund ─────────────▶ │ ──▶ Fuji:退還押金
```

| 元件 | 位置 | 職責 |
| --- | --- | --- |
| 買方 agent | `src/agent/` | 測試網錢包、押金政策、每格重簽 voucher、花費上限、兩段式 Ctrl-C |
| 賣方 server | `src/server/` | `/tick` 套 x402 middleware、押金守門、session 帳本、watchdog 剪線、SSE 串流、claim/settle/refund 排程 |
| facilitator | `src/facilitator/` | 自架 TypeScript 版,驗證付款並把 deposit / claim / settle / refund 送上鏈 |

鏈上驗證與結算交給 facilitator,payment channel 用 x402 已部署的 batch-settlement 合約,不用自己寫合約。

### 兩層帳本

`session` 管「這條 SSE 還能活多久」(`paidUntilMs`、`tickCount`,生命週期是一次串流);
`channel` 管「這個買方的押金還剩多少」(`balance`、`totalClaimed`、`chargedCumulativeAmount`,跨多次串流)。
session 被剪除不影響 channel;押金耗盡則所有 session 都無法延長。

### 賣方要自己守的三條規則

協議不會代勞,全部在 server 端:

1. **押金守門** —— 送 token 前必須確認 `已消耗 + 本格金額 ≤ 押金`。[channels.ts](src/server/channels.ts) 是純函數,[settleHook.ts](src/server/settleHook.ts) 每格回頭檢查
2. **claim 時效** —— 買方可發起提領,賣方必須在 `WITHDRAW_DELAY_SECS` 內把最新 voucher claim 上鏈;[claimJob.ts](src/server/claimJob.ts) 讓提領申請插隊並在逾期時告警
3. **狀態持久化** —— 最新那張 voucher 的簽章只存在賣方手上,掉了就是真的收不到錢。實跑一律用 file storage,`CHANNEL_STORAGE_DIR` 已列入 `.gitignore`

## 技術棧

### 語言與執行環境

- **Node.js + TypeScript(strict、`noUncheckedIndexedAccess`),ESM** —— `tsx` 直接執行,沒有 build 步驟
- **Express 5** —— 賣方 server 的 HTTP 層,三個端點 `/tick`、`/stream`、`/health` 都在它上面
- **zod** —— 所有環境變數與計費參數經 [src/config.ts](src/config.ts) 驗證後注入,無硬編碼

### 付款協議:x402 v2

- **server 端**([src/server/payment.ts](src/server/payment.ts)):`@x402/express` 把 x402 middleware 掛在 `/tick`,`@x402/evm/batch-settlement/server` 的 `BatchSettlementEvmScheme` 驗券、記帳並持久化 channel;`BatchSettlementChannelManager` 在熱路徑外跑 claim / settle / refund
- **agent 端**([src/agent/wallet.ts](src/agent/wallet.ts)):`@x402/fetch` 攔截 402、自動簽付款重送;`@x402/evm/batch-settlement/client` 負責押金政策、每格重簽 voucher、累計基準失步時的 corrective 402 復原,**viem** 做 EIP-712 簽章並當買方錢包層
- **結算方式:** scheme `batch-settlement`(payment channel)。押金走 **ERC-3009 `receiveWithAuthorization`**,所以 **agent 錢包不需要 AVAX**,gas 全由 facilitator 的 signer 支付

#### 誰來簽 claim / refund 授權

`receiverAuthorizer` 是授權賣方請款的那把鑰匙。設了 `LLM_PROVIDER_AUTHORIZER_PRIVATE_KEY` 就由**賣方自己**簽;留空則委派給 facilitator,此時 facilitator 必須在 `/supported` 廣告自己的 `receiverAuthorizer`,否則 server 拒絕啟動。PoC 兩種都可跑,自架 facilitator 下委派是合理的;正式環境應由賣方持有。

### 鏈:Avalanche Fuji 測試網

- Avalanche 本身是 L1 區塊鏈;本專案用的是它內建的 EVM 鏈 **C-Chain** 測試網(Fuji),CAIP-2 識別字 `eip155:43113`,EIP-1559
- **資產:** 測試網 USDC `0x5425890298aed601595a70AB815c96711a31Bc65`,6 decimals
- 沒有用到 Avalanche L1(應用專用鏈,舊稱 subnets)—— C-Chain 的 ERC-20 結算就夠了

#### 為什麼選 Avalanche

在「以秒計費、即時剪線」的高頻串流場景,Avalanche 解決了微支付閘道最棘手的物理限制:

- **次秒級確定性,讓開場押金夠快落地。** Snowman 共識約 0.8～1.5 秒達成確定性結算(2026-09-11 實測:出塊約 1 秒)。改用 payment channel 後,只有第一格要等鏈,之後每格都是鏈下 voucher —— 剪線速度因此**完全不受鏈的性質影響**
- **極低 gas,讓開場與請款都便宜。** 一筆 settle 實測約 85,720 gas;改成批次請款後,上鏈次數已與格數脫鉤,主網化的經濟性才成立(每格上鏈在主網不成立 —— gas 與一格的收入同量級)
- **成熟 EVM 相容性。** 完全相容 EVM,直接沿用 EIP-712 簽章驗證與標準 ERC-20 呼叫,x402 的 batch-settlement 合約屬確定性部署、各鏈同址,自架 facilitator 不需從頭造輪子
- **專屬鏈的擴展路徑。** 日後推論量暴增、微支付頻率更高,可佈建專屬 Avalanche L1(舊稱 Subnet)自訂手續費代幣甚至降至零,避免公共網路塞車影響推論即時性

### facilitator:自架 TypeScript 版

- [x402-rs](https://github.com/x402-rs/x402-rs) **不支援 batch-settlement**(README 連 upto 與 deferred 都標 Planned),因此改用 `@x402/core/facilitator` 的 `x402Facilitator`,註冊 `@x402/evm/batch-settlement/facilitator` 的 scheme
- `x402Facilitator` 只是一個類別,不含 HTTP 伺服器 —— [src/facilitator/app.ts](src/facilitator/app.ts) 補上 `/verify`、`/settle`、`/supported`、`/health` 四個端點,形狀對齊 x402-rs;`npm run facilitator` 或 [docker-compose.yml](docker-compose.yml) 都可以起
- 順帶解掉 x402-rs 的輪詢問題:它把 `is_local` 寫死為 `false`,alloy 因此用 7000ms 預設輪詢等 receipt,設定檔沒有可調選項。自架版由我們自己建 viem client,**viem 對 Fuji 的預設值是 2000ms**,本專案設為 `FACILITATOR_POLLING_MS=250`
- facilitator 的 signer 需自備 AVAX,它負責送出 deposit / claim / settle / refund 四種交易

### 測試與驗證

- **Vitest + supertest** —— 純函數單元測試 + HTTP 合約測試(搭假 facilitator),都不碰鏈
- 覆蓋率門檻 80%(v8 provider,不含 `main.ts` 等進入點)

> ⚠️ **僅用測試網。** AVAX 從 Core Wallet console 領,USDC 從 Circle faucet 領,切勿使用真實資產。facilitator 的 signer 錢包需自備 AVAX 支付 gas。

兩個容易踩的坑,實作前先看一眼:

- **不要用 `x402-express`。** 那是 v1,已 deprecated 且僅接收 security patch,API 形狀與 network 識別字都與 v2 不同。多數第三方教學仍停在 v1 寫法,一律以 `coinbase/x402` repo 的 v2 範例為準。
- **voucher 上的兩個數字不能混。** `maxClaimableAmount` 是買方簽的**累計上限**(= 買方的曝險),`chargedCumulativeAmount` 是賣方記的**實際消耗**。合約只保證不超過上限,不保證等於服務量 —— 所以 client 必須每格重簽、上限只加一格。一次簽一個大上限等於把整筆押金交給賣方自律。
- **Fuji 的 USDC EIP-712 domain name 是 `USD Coin`,不是 `USDC`。** Base Sepolia 才是 `USDC`。填錯會導致簽章驗證失敗,而錯誤訊息不會指向此處。

## 參數

### 串流計費

| 參數 | 值 | 說明 |
| --- | --- | --- |
| `CREDIT_PER_TICK_MS` | `1000` | 一格買到的串流時間 |
| `TOPUP_THRESHOLD_MS` | `300` | 餘額低於此值即簽下一張 voucher |
| `GRACE_MS` | `250` | 逾期後 server 才剪線的寬限 |
| `WATCHDOG_SWEEP_MS` | `100` | 剪線掃描週期 |
| `PRICE_PER_TICK_ATOMIC` | `40` | 0.00004 USDC |
| `MAX_SPEND_ATOMIC` | `50000` | 0.05 USDC,agent 的花費上限 |

### Payment channel

| 參數 | 值 | 說明 |
| --- | --- | --- |
| `DEPOSIT_ATOMIC` | `50000` | 0.05 USDC ≈ 1,250 格 ≈ 21 分鐘 |
| `DEPOSIT_TOPUP_ATOMIC` | `5000` | 押金餘額低於此值即補押金 |
| `WITHDRAW_DELAY_SECS` | `900` | 買方非合作提領的等待期 |
| `CLAIM_INTERVAL_SECS` | `60` | 賣方批次請款週期 |
| `SETTLE_INTERVAL_SECS` | `300` | 已請款餘額轉出週期 |
| `REFUND_IDLE_SECS` | `120` | channel 閒置多久後主動退款 |
| `MAX_CLAIMS_PER_BATCH` | `20` | 一筆 claim 交易最多帶幾張 voucher |
| `WITHDRAW_POLL_MS` | `5000` | 提領申請的插隊輪詢間隔 |
| `CHANNEL_STORAGE_DIR` | `.dripllm/channels` | voucher 簽章的持久化位置,已列入 `.gitignore` |

必須滿足的約束由 zod 在啟動時擋下:`TOPUP_THRESHOLD_MS < CREDIT_PER_TICK_MS`、`WITHDRAW_DELAY_SECS > CLAIM_INTERVAL_SECS`、`WITHDRAW_POLL_MS < WITHDRAW_DELAY_SECS`。

agent 是在**餘額將盡時**補款,不是固定間隔付款 —— 若「每 N 秒付一次」而「一筆買 N 秒」,網路與結算延遲會讓餘額逐 tick 向下漂移,幾個 tick 後就會在沒人介入的情況下自行斷流。所有參數經 [src/config.ts](src/config.ts) 以 zod 驗證後注入,無硬編碼。

### 2026-09-20 的 Fuji 實測

| 量測項 | 實測值 |
| --- | --- |
| 單格 voucher 的 `/tick` 往返 | **7～16ms**(對照 per-tick 上鏈的 6.9～8.1 秒,快約 500 倍) |
| 開場 deposit 上鏈 | **5.6～6.9 秒** |
| claim 上鏈 | **3.8 秒** · gas 58k～75k(1 張 voucher 涵蓋 11 格) |
| deposit gas | 140k～160k |
| viem 對 Fuji 的預設 `pollingInterval` | 2000ms(本專案設 250ms) |

`TOPUP_THRESHOLD_MS = 300` 對 16ms 的往返有近 20 倍餘裕,`CREDIT_PER_TICK_MS = 1000` 站得住。

> ⚠️ **首個 token 的延遲沒有降到原本估的 1～2 秒,實測約 6～7 秒。** deposit 要等鏈,而 ERC-3009 的 deposit 比單純轉帳貴得多(gas 140k～160k,對照 claim 的 58k～75k)。這不影響本專案要證明的量 —— **停付到剪線的曝險窗口已經與鏈完全脫鉤**,只有開場那一筆還在鏈上。

## 快速開始

```bash
# 1. 安裝相依套件
npm install

# 2. 設定環境變數(買方錢包、facilitator signer、facilitator URL 等)
cp .env.example .env

# 3. 領測試幣:facilitator signer 需要 AVAX 付 gas,買方 agent 需要 USDC

# 4. 起 facilitator
npm run facilitator

# 5. 啟動賣方 server
npm run server

# 6. 另開一個終端,啟動買方 agent
npm run agent
```

facilitator 沒起來時 server 會拒絕啟動,並直接告訴你原因。

## Demo 觀察重點

- 每個 tick 的付款、tx hash、累計花費(USDC),以及持續流動的 token
- server 端的餘額倒數 —— 讓觀眾知道那幾秒不是當機

  ```
  [hook]    · session 7f3a · tick #12 · voucher · 押金尚可 1238 格
  [server]  · session 7f3a · 餘額 0.4s
  [server]  · session 7f3a · ⚠ 逾期,寬限 250ms
  [server]  · session 7f3a · ✂ 切斷串流
  ```

- agent 端每格顯示押金餘額(`bal`)、已簽上限(`cap`)與累計消耗(`sum`)——
  只有第一格有 tx hash,之後都是 `voucher`

- **第一次 Ctrl-C:** agent 停止付款,但**保持連線**、繼續讀取 stream
- **斷流那一刻:** 停付到剪線的上界 = 剩餘額度 + `GRACE_MS` + 一個 sweep 週期 ≈ **1.35 秒**,agent 端顯示連線已被 server 關閉
- 第二次 Ctrl-C 才真正退出

第一次 Ctrl-C 不斷線是整個 demo 成立的關鍵 —— agent 仍連著、仍在等待,線是 server 剪的。把 `MAX_SPEND_ATOMIC` 調低,agent 撞上花費上限後會自動停付,產生一模一樣的斷流結果。

## 測試

```bash
npm test              # 純函數單元測試 + HTTP 合約測試,都不碰鏈
npm run smoke         # 對真實 Fuji 跑 3 個 tick,輸出 tx hash(手動,不進 CI)
npm run smoke:channel # deposit → 10 格 voucher → claim → refund,輸出各階段 tx 與 gas(手動,不進 CI)
```

合約測試搭配假 facilitator —— 它的**記帳與 EIP-712 簽章驗證都是真的**,只省略上鏈,
因此「押金耗盡就不送 token」「上限未遞增就拒絕」「簽章錯就拒絕」都是真的被證明過,不是只證明 HTTP 有通。
涵蓋率門檻 80%(v8 provider,不含 `main.ts` 等進入點)。

`npm run smoke:channel` 會送出**真實的 Fuji 交易**並消耗測試網 USDC 與 AVAX;
它只需要 facilitator 先起來,server 由腳本自己在行程內啟動,才能在正確時點手動觸發 claim。

## 專案狀態

概念驗證(PoC)。推論後端目前是罐頭 token 串流,日後接真實 LLM 只需替換 `TokenSource` 的實作,收費那層無需改動。

設計決策與細節見[設計文件](docs/superpowers/specs/2026-09-06-dripllm-design.md)。

## License

MIT
