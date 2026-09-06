# DripLLM

> 按用量付費的 LLM 推論串流 —— 持續付費才有推論,停付就被剪線。

DripLLM 是一個示範 **agent payment** 的最小可跑專案。買方 agent 掛在一條 SSE 串流上,每一筆 USDC 微支付買到一段串流時間,餘額將盡時自動補款;一旦停止付款,餘額燒完加上寬限期,賣方 server 主動切斷連線。付款透過 [x402](https://x402.org) 協議完成,鏈上驗證與結算交給自架的 facilitator 在 Avalanche Fuji 測試網執行。

## 為什麼做這個

傳統扣款是為「人」設計的:金額夠大、有人按確認、事先綁帳號。這些假設在 agent 世界會全部崩掉 —— 機器之間的付款往往是**高頻、微額、免帳號、需可程式化管控**的。DripLLM 用「停付即斷流」這一個畫面,示範 agent payment 補上了傳統扣款做不到的那塊。

## 運作原理

一次 tick 的資料流:

1. agent 送出 `POST /tick`,沒帶付款 → server 回 `HTTP 402` 附上價格與收款資產
2. agent 簽一筆 USDC 付款,塞進 `X-PAYMENT` header 重送
3. facilitator 驗證付款簽章,並在 Fuji 上結算
4. server 建立 session,回 `{ sessionId, paidUntilMs, txHash }`
5. agent 用該 sessionId 開一條 `GET /stream` 的 SSE 連線,token 開始流動
6. 餘額低於門檻時,agent 自動再送一筆 `POST /tick` 把 `paidUntil` 往後延

**核心機制:** server 的 watchdog 定期掃描 session 帳本,逾期又超過寬限的 session 會收到 `event: cut`,連線隨即被 server 關閉。

### 為什麼是 SSE 長連線

如果每個 tick 都是一個獨立 request,「斷流」不過是 agent 自己 break 掉迴圈 —— 畫面上分辨不出 server 強制與 agent 自願停止,server 從頭到尾沒行使任何權力。

改成長連線後,agent 還連著、還想要,線卻被剪了。強制力因此是看得見的,Ctrl-C 也才能當作 demo 的觸發鍵。

### 三個端點,只有一個收費

| 端點 | x402 | 職責 |
| --- | --- | --- |
| `POST /tick` | 收費 | 付一筆 → 建立或延長 session |
| `GET /stream?sessionId=` | 免費 | SSE,session 活著就吐 token |
| `GET /health` | 免費 | 啟動檢查與 demo 腳本 |

`/stream` 免費不構成漏洞:**session 只有付過錢才存在**,不存在拿到免費 token 的路徑。這讓 x402 middleware 留在它天生擅長的 per-request 位置,SSE 那條完全不碰付款邏輯。

## 架構

```
   buyer agent                    seller server                    facilitator
      │  ──── POST /tick ───────────▶ │  ─── verify / settle ─────────▶ │ ──▶ Fuji (USDC)
      │  ◀─── {sessionId, paidUntil} ─┤                                 │
      │  ──── GET /stream ──────────▶ │
      │  ◀═══ token token token ══════╡   watchdog: now > paidUntil + grace
      │  ◀─── event: cut ─────────────┤   ✂ server 剪線
```

| 元件 | 位置 | 職責 |
| --- | --- | --- |
| 買方 agent | `src/agent/` | 測試網錢包、花費上限、餘額將盡時補款、兩段式 Ctrl-C |
| 賣方 server | `src/server/` | `/tick` 套 x402 middleware、session 帳本、watchdog 剪線、SSE 串流 |
| facilitator | `docker-compose.yml` + `facilitator/` | 自架 x402-rs,驗證付款簽章並在鏈上結算 |

鏈上驗證與結算交給 facilitator,不用自己寫合約。

## 技術選型

- **協議:** x402 **v2** —— `@x402/express`、`@x402/core`、`@x402/evm`、`@x402/fetch` 搭 `viem`
- **結算方式:** scheme `v2-eip155-exact`,每個 tick 一筆獨立付款,邏輯最單純
- **鏈:** Avalanche Fuji 測試網,CAIP-2 識別字 `eip155:43113`
- **資產:** 測試網 USDC `0x5425890298aed601595a70AB815c96711a31Bc65`,6 decimals
- **facilitator:** 自架 [x402-rs](https://github.com/x402-rs/x402-rs),Docker 一鍵起

> ⚠️ **僅用測試網。** AVAX 從 Core Wallet console 領,USDC 從 Circle faucet 領,切勿使用真實資產。facilitator 的 signer 錢包需自備 AVAX 支付 gas。

兩個容易踩的坑,實作前先看一眼:

- **不要用 `x402-express`。** 那是 v1,已 deprecated 且僅接收 security patch,API 形狀與 network 識別字都與 v2 不同。多數第三方教學仍停在 v1 寫法,一律以 `coinbase/x402` repo 的 v2 範例為準。
- **Fuji 的 USDC EIP-712 domain name 是 `USD Coin`,不是 `USDC`。** Base Sepolia 才是 `USDC`。填錯會導致簽章驗證失敗,而錯誤訊息不會指向此處。

facilitator 也選擇自架而非託管:`facilitator.x402.rs` 的託管實例不支援 Fuji,thirdweb 託管需綁第三方帳號且文件停在 v1。x402-rs 按 CAIP-2 chain id 泛用配置,加一個 `eip155:43113` 條目即可。

## 參數

| 參數 | 值 | 說明 |
| --- | --- | --- |
| `CREDIT_PER_TICK_MS` | `5000` | 一筆付款買到的串流時間 |
| `TOPUP_THRESHOLD_MS` | `2000` | 餘額低於此值即補款 |
| `GRACE_MS` | `2000` | 逾期後 server 才剪線的寬限 |
| `PRICE_PER_TICK_ATOMIC` | `1000` | 0.001 USDC |
| `MAX_SPEND_ATOMIC` | `50000` | 0.05 USDC,約 50 個 tick |

agent 是在**餘額將盡時**補款,不是固定間隔付款 —— 若「每 N 秒付一次」而「一筆買 N 秒」,網路與結算延遲會讓餘額逐 tick 向下漂移,幾個 tick 後就會在沒人介入的情況下自行斷流。所有參數經 `src/config.ts` 以 zod 驗證後注入,無硬編碼。

## 快速開始

```bash
# 1. 安裝相依套件
npm install

# 2. 設定環境變數(買方錢包、facilitator signer、facilitator URL 等)
cp .env.example .env

# 3. 領測試幣:facilitator signer 需要 AVAX 付 gas,買方 agent 需要 USDC

# 4. 起 facilitator
docker compose up -d

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
  [server] session 7f3a · 餘額 1.2s
  [server] session 7f3a · 餘額 0.4s
  [server] session 7f3a · ⚠ 逾期,寬限 2.0s
  [server] session 7f3a · ✂ 切斷串流
  ```

- **第一次 Ctrl-C:** agent 停止付款,但**保持連線**、繼續讀取 stream
- **斷流那一刻:** 約 4～7 秒後 server 主動剪線,agent 端顯示連線已被 server 關閉
- 第二次 Ctrl-C 才真正退出

第一次 Ctrl-C 不斷線是整個 demo 成立的關鍵 —— agent 仍連著、仍在等待,線是 server 剪的。把 `MAX_SPEND_ATOMIC` 調低,agent 撞上花費上限後會自動停付,產生一模一樣的斷流結果。

## 測試

```bash
npm test          # 純函數單元測試 + HTTP 合約測試,都不碰鏈
npm run smoke     # 對真實 Fuji 跑 3 個 tick,輸出 tx hash(手動,不進 CI)
```

合約測試搭配假 facilitator,涵蓋率門檻 80%。

## 專案狀態

概念驗證(PoC)。推論後端目前是罐頭 token 串流,日後接真實 LLM 只需替換 `TokenSource` 的實作,收費那層無需改動。

設計決策與細節見[設計文件](docs/superpowers/specs/2026-09-06-dripllm-design.md)。

## License

MIT
