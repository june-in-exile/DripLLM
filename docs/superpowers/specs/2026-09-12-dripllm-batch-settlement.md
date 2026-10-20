# DripLLM — Payment Channel (batch-settlement) Design Document

> Change "one tick = 25 seconds, one on-chain transaction per tick" into "one tick = 1 second, one off-chain voucher per tick".
>
> Follows on from the [2026-09-06 design document](2026-09-06-dripllm-design.md), referred to below as "the original spec". Anything not mentioned here carries over from the original spec.

---

## 1. Goals

### 1.1 The problem to solve

The original spec's parameters (25-second ticks, a 15-second top-up threshold, 2–27 seconds from stopping payment to the cut) were not design preferences; they were forced on us by how long on-chain settlement takes. Breakdown measured on 2026-09-11 (5 ticks, with a timing proxy inserted between the server and the facilitator, cross-checked against the block's `timestampMilliseconds`):

| Segment | Duration | Share |
| --- | --- | --- |
| 402 challenge + signature + handler | 13–54ms | < 1% |
| verify | 0.5–0.7s (5.8s on the first cold start) | ~7% |
| settle: request received → block produced | 0.95–1.02s | ~13% |
| settle: block produced → facilitator response | 5.3–7.4s | ~80% |
| **Whole tick** | **6.9–8.1s** | |

The cause of the last segment has been pinpointed: x402-rs's `crates/chains/x402-chain-eip155/src/chain/provider.rs` creates its client with `RpcClient::new(fallback, false)`, hard-coding `is_local` to `false`, so alloy uses its 7000ms default polling interval (only local gets 250ms), and the receipt is awaited via `pending_tx.get_receipt()`. There is no configurable option in the config file, and the EVM transport layer only accepts http/https (WebSocket gets filtered out).

**Two conclusions:**

1. The chain is not the bottleneck. Producing a block takes only about 1 second, consistent with Snowman's finality.
2. Even with the polling fixed, settle still has a floor of about 1.5 seconds (1 second for the block + polling + RTT), and with the added constraint that "the top-up threshold must exceed settle", a tick has to be at least around 5 seconds. **The per-tick on-chain approach cannot reach the 1-second scale.**

There is also an economic reason: one settle was measured at 85,720 gas. Fuji testnet's base fee is currently near zero (about `1.4e-11` AVAX per transaction), but on mainnet at 1–25 nAVAX the same transaction costs about 0.0001–0.002 AVAX — the same order of magnitude as one tick's 0.001 USDC of revenue, or even more. **Going on-chain every tick does not work on mainnet.**

### 1.2 What this document aims to achieve

- One tick = **1 second**; each tick's payment is an **off-chain signed cumulative voucher**, millisecond-scale and gas-free
- Cut the time from stopping payment to the cut down to **about 1.65 seconds** or less (one tick + top-up threshold + grace period + watchdog sweep; originally written as 1.35 seconds, see §12.9 for the correction)
- Reduce on-chain transactions from "one every 25 seconds" to "one at start + periodic batched claims by the seller"
- Shrink the buyer's per-payment exposure from 25 seconds' worth to 1 second's worth

### 1.3 Non-goals

- No change to the existing SSE streaming and cut architecture (original spec §2.1, §2.4, §6.3 all carry over)
- No real LLM (still the canned `TokenSource`)
- No mainnet
- No writing our own smart contracts (use x402's already-deployed batch-settlement contracts)
- No multi-buyer scaling, but channel storage must be persistable (§2.5)

---

## 2. Core design decisions

### 2.1 One tick per second, payment becomes an off-chain voucher

| Option | Tick floor | On-chain frequency | Why not adopted |
| --- | --- | --- | --- |
| Current `exact` + fixed x402-rs polling | ~5s | One per tick | Can't reach the 1-second scale; mainnet gas costs more than revenue |
| `upto` scheme | Same as above | One per tick | Goes through Permit2; the agent must first do an on-chain approve and also hold AVAX |
| **`batch-settlement` (adopted)** | **1s or less** | 1 at start + periodic batches | — |

`batch-settlement` is a payment channel: the buyer first puts a deposit into the contract, and after that each request only signs a "cumulative cap" voucher and hands it to the seller; the seller periodically takes the latest one on-chain to claim. **Because the voucher records a cumulative amount, 1000 ticks need only the last one submitted, at the same gas as 1 tick.**

### 2.2 Endpoints and SSE completely unchanged

The three endpoints `POST /tick`, `GET /stream`, `GET /health`, the `X-Drip-Session` header, and the three SSE event types `token`/`credit`/`cut` all stay as they are. The only changes are the scheme mounted on the x402 middleware and how much time one tick buys.

Rationale: the division of labor in original spec §2.2 (only `/tick` charges, a session exists only after a successful payment) is orthogonal to the payment scheme. Keeping it unchanged concentrates this change's diff in the billing layer.

### 2.3 Channel lifecycle

```
① deposit   buyer              deposit into contract + first voucher            on-chain (sent by facilitator)
② voucher   buyer, per tick    cumulative cap +1 tick, signed, handed to seller  off-chain (ms)
③ claim     seller, periodic   submit latest voucher, recorded in totalClaimed  on-chain
④ settle    seller, periodic   transfer claimed balance to receiving address    on-chain
⑤ refund    at the end         return unspent deposit to buyer                  on-chain
```

Everything other than ② is off the hot path. ③④ are run by `BatchSettlementChannelManager` according to policy, independent of the buyer's request cadence.

### 2.4 The voucher's cap grows by only one tick per tick (key decision)

A voucher involves two different numbers, and confusing them leads directly to loss of funds:

| Field | Who signs | Meaning |
| --- | --- | --- |
| `maxClaimableAmount` | Buyer (`payerAuthorizer`) | Cumulative **cap** — authorizes the seller to collect at most this amount |
| `chargedCumulativeAmount` | Seller's local ledger | Service already delivered, cumulative amount owed |
| `totalClaimed` | Seller (`receiverAuthorizer`) | Cumulative amount already claimed on-chain via the latest voucher |

The contract only guarantees "no more than the cap the buyer signed"; it **does not guarantee "equal to the service actually delivered"**. Therefore:

> **The buyer's exposure = the signed cap, not the consumed amount.**

So the client-side strategy must be: **re-sign every tick, with cap = consumed + 1 tick**. Any approach of "sign one big cap at once to save on signatures" amounts to handing the entire deposit over to the seller's self-restraint, which is exactly the trade-off this project sets out to avoid. Signing is off-chain, millisecond-scale, and gas-free, so signing once per tick has no cost problem.

This rule also holds up the demo's core property: **stop paying = no new vouchers signed = credit no longer extended = cut.**

### 2.5 Three rules the seller must enforce itself

The protocol will not block the following three things for the seller; all of them must be implemented on the server side:

1. **Deposit gate.** A voucher's cap can be signed higher than the channel balance, but the excess cannot be collected at claim time. Before sending any token, the server must confirm `chargedCumulativeAmount + amount to charge this time ≤ balance`. `totalClaimed` is used only to compute receivables not yet claimed on-chain (`chargedCumulativeAmount − totalClaimed`); a successful claim does not restore servable credit. This is the only real seller loss-of-funds path, and it must be a pure function, tested exhaustively (§6.2).
2. **Claim deadline.** The buyer can initiate a withdrawal; `withdrawRequestedAt` is recorded on the channel, and after `withdrawDelay` seconds the deposit can be withdrawn. The seller must claim the latest voucher on-chain within this delay, so `getWithdrawalPendingSessions()` must be wired into monitoring and trigger an immediate claim.
3. **State persistence.** The latest voucher's signature exists only in the seller's hands; a server restart means giving up that stretch of revenue. `InMemoryChannelStorage` may only be used in tests; real runs always use file or redis storage.

> Point 3 is the same kind of problem as the original spec keeping the session ledger only in memory, but with different consequences: losing a session just means disconnecting and starting over; losing a voucher means really not getting paid.

### 2.6 Session and channel are two layers, not merged

`sessionId` is still generated by the agent (original spec §2.2.1), while `channelId` is derived from `ChannelConfig` by `computeChannelId(channelConfig, network)`. The two are one-to-one but do not share an identifier:

- The session governs "how much longer this SSE stream can live" — `paidUntilMs`, `tickCount`; its lifetime is one stream
- The channel governs "how much deposit this buyer has left" — `balance`, `totalClaimed`, `chargedCumulativeAmount`; its lifetime spans many streams

A session being cut does not affect the channel (the deposit is still there, and a new stream can be opened); once the channel's deposit is exhausted, no session can be extended.

### 2.7 Facilitator replaced with a self-hosted TypeScript version

x402-rs does not support batch-settlement (its README even marks upto and deferred as Planned), so we switch to `x402Facilitator` from `@x402/core/facilitator`, registering the scheme from `@x402/evm/batch-settlement/facilitator`.

**Note: `x402Facilitator` is just a class providing three methods, `verify()`, `settle()`, `getSupported()`; it includes no HTTP server.** The HTTP layer has to be written ourselves as an Express app of about 60 lines (§3.3).

This also incidentally solves the original spec's 7-second polling problem: in the self-hosted version we build the viem client ourselves, so `pollingInterval` can be set directly to 250–500ms. **viem's default value must be measured and confirmed in the spike as well.**

### 2.8 The cut decision never touches the chain

The watchdog logic is unchanged; it is still `now > paidUntilMs + GRACE_MS`. The difference is that extending `paidUntilMs` comes from verifying an off-chain voucher (milliseconds), not from an on-chain transaction (seconds). **Cut speed is therefore no longer affected by any property of the chain.**

Original spec §2.5, "session creation and extension happen in `onAfterSettle`", is kept unchanged. The rationale shifts from "avoid settlement latency eating into credit" to "keep a single entry point" — a voucher's settle does not go on-chain and latency drops to milliseconds, but keeping the entry point in the same place minimizes the diff and preserves the property that "a session exists only after a successful payment".

---

## 3. Technology choices

### 3.1 Package and class mapping

| Role | Current | Changed to |
| --- | --- | --- |
| server scheme | `ExactEvmScheme` from `@x402/evm/exact/server` | `BatchSettlementEvmScheme(receiverAddress, { storage, receiverAuthorizerSigner, withdrawDelay })` from `@x402/evm/batch-settlement/server` |
| client scheme | `ExactEvmScheme` from `@x402/evm/exact/client` | `BatchSettlementEvmScheme` from `@x402/evm/batch-settlement/client` (with deposit policy) + `createBatchSettlementClientHooks` |
| Seller claims | None | `BatchSettlementChannelManager({ scheme, facilitator, receiver, token, network })` |
| facilitator | x402-rs (Docker) | `x402Facilitator` + `@x402/evm/batch-settlement/facilitator` |
| Channel storage | None | server: `ChannelStorage` (file / redis); client: `ClientChannelStorage` |

Ready-made capabilities already provided on the client side (no need to implement ourselves): `buildChannelConfig`, `computeChannelId`, `signVoucher`, `createBatchSettlementEIP3009DepositPayload`, `depositAmountForRequest`, `refundChannel`, `recoverChannel`, `processCorrectivePaymentRequired`.

### 3.2 Chain and contracts (Fuji, verified with `eth_getCode`)

| Item | Address | Status |
| --- | --- | --- |
| BatchSettlement | `0x4020074e9dF2ce1deE5A9C1b5c3f541D02a10003` | Deployed (11,175 bytes) |
| ERC3009 Deposit Collector | `0x4020806089470a89826cB9fB1f4059150b550004` | Deployed (1,150 bytes) |
| USDC (Fuji) | `0x5425890298aed601595a70AB815c96711a31Bc65` | Carried over |

Address source: `dist/cjs/index.js:1644-1645` in `@x402/evm@2.25.0`, which is a **single string constant rather than a per-chain lookup table** — a deterministic deployment at the same address on every chain, consistent with original spec §9.1's observation about the Permit2 proxy.

> **Verification only goes as far as "there is bytecode at that address".** `eth_getCode` does not compare bytecode contents, and the contract has never actually been called, so we cannot yet guarantee the version matches the package. The real verification is item 1 of the §8 spike: actually send one deposit and confirm it lands on-chain.

The deposit goes through **ERC-3009** (`receiveWithAuthorization`), so **the agent wallet still needs no AVAX**; all gas is paid by the facilitator's signer. This is one of the main reasons for not choosing `upto` (it only supports Permit2, which requires an on-chain approve).

### 3.3 HTTP interface of the self-hosted facilitator

`x402Facilitator` has no HTTP layer, so we must provide three endpoints ourselves, compatible with x402-rs:

```
POST /verify     → facilitator.verify(paymentPayload, paymentRequirements)
POST /settle     → facilitator.settle(paymentPayload, paymentRequirements)
GET  /supported  → facilitator.getSupported()
GET  /health     → startup check in server/main.ts carries over
```

Assembly shape (dist is authoritative for details):

```ts
const facilitator = new x402Facilitator()
  .register(FUJI_USDC.network, new BatchSettlementEvmScheme(signer, authorizerSigner, config));
```

The facilitator's signer still needs its own AVAX; it is responsible for sending four kinds of transactions: deposit / claim / settle / refund.

---

## 4. Execution sequence

```
agent                         server                     facilitator            Fuji
  │                             │                             │                  │
  ├─ POST /tick ───────────────▶│                             │                  │
  │◀─ 402 + deposit/cap reqs ───┤ (extra: receiverAuthorizer, withdrawDelay)     │
  │ ① sign deposit + 1st voucher│                             │                  │
  ├─ POST /tick + X-PAYMENT ───▶├─ verify ───────────────────▶│                  │
  │                             ├─ settle ───────────────────▶├─ deposit tx ────▶│
  │                             │◀──────────────────────── ok ┤                  │
  │                             ├─ hook: create session       │                  │
  │◀── {sessionId, accepted} ───┤   paidUntil = now + TICK_MS  │                  │
  ├─ GET /stream ──────────────▶│                             │                  │
  │◀═══ token / credit ═════════╡                             │                  │
  │                             │                             │                  │
  │  ② each tick: sign voucher (cap +1 tick)                  │                  │
  ├─ POST /tick + X-PAYMENT ───▶├─ verify sig + gate (§2.5.1)▶│ off-chain, ms    │
  │◀═══ token token ════════════╡   paidUntil += TICK_MS       │                  │
  │                             │                             │                  │
  │ ^C stop paying (no vouchers)│                             │                  │
  │◀═══ token ══════════════════╡ credit runs out + GRACE_MS  │                  │
  │◀─── event: cut ─────────────┤ watchdog cut (within ≈1.65s)│                  │
  │                             │                             │                  │
  │                             ├─ ③④ periodic claim/settle ─▶├─ on-chain ──────▶│
  │                             ├─ ⑤ refund when idle ───────▶├─ return deposit ▶│
```

**Stop paying to cut = remaining credit at the moment payment stops + `GRACE_MS` + at most one sweep period.** The agent only tops up when the remaining credit falls below `TOPUP_THRESHOLD_MS`, and right after a top-up the remaining credit is at most one tick + the threshold, so the remaining credit ranges over 0–1.3 seconds, not 0–1 seconds. Using the recommended values in §5: 1.3 seconds + `GRACE_MS` 250ms + sweep 100ms, **an upper bound of about 1.65 seconds** (currently 2–27 seconds; originally written as 1.35 seconds, see §12.9 for the correction).

**First-token latency does not drop to zero.** The first tick must wait for the deposit to land on-chain, originally estimated at 1–2 seconds (block about 1 second + 250ms polling + RTT); the §8 spike measured **5.6–6.9 seconds** (an ERC-3009 deposit involves more gas and more steps than a plain transfer, see §12.4). Currently it is 7–14 seconds.

---

## 5. Parameters

> **All are recommended starting values, finalized by the §8 spike measurements.** Anything marked "to be measured" must not be hard-coded before it has been measured.

### 5.1 Stream billing

| Parameter | Recommended value | Description |
| --- | --- | --- |
| `CREDIT_PER_TICK_MS` | `1000` | Streaming time one tick buys, changed from 25000 to 1000 |
| `TOPUP_THRESHOLD_MS` | `300` | Sign the next voucher once remaining credit falls below this (> signature + `/tick` RTT, to be measured) |
| `GRACE_MS` | `250` | Changed from 2000 to 250 |
| `PRICE_PER_TICK_ATOMIC` | `40` | 0.00004 USDC, keeping the current per-second rate (0.001 / 25s) |
| `CREDIT_EVENT_MS` | `250` | Changed from 500 to 250, to match one tick per second |
| `WATCHDOG_SWEEP_MS` | `100` | Changed from 250 to 100 |
| `TOKEN_INTERVAL_MS` | `120` | Unchanged |
| `TOMBSTONE_TTL_MS` | `60000` | Unchanged |
| `MAX_SPEND_ATOMIC` | `50000` | Unchanged, the agent's spending cap |

### 5.2 Channel

| Parameter | Recommended value | Description |
| --- | --- | --- |
| `DEPOSIT_ATOMIC` | `50000` | 0.05 USDC ≈ 1,250 ticks ≈ 21 minutes |
| `DEPOSIT_TOPUP_ATOMIC` | `5000` | Top up the deposit once the remaining deposit falls below 0.005 USDC (≈125 seconds) |
| `WITHDRAW_DELAY_SECS` | `900` | Waiting period for a buyer's non-cooperative withdrawal; must be > claim period + on-chain latency + margin |
| `CLAIM_INTERVAL_SECS` | `60` | Seller's batched claim period |
| `SETTLE_INTERVAL_SECS` | `300` | Period for transferring out the claimed balance |
| `REFUND_IDLE_SECS` | `120` | How long a channel stays idle before a proactive refund |
| `MAX_CLAIMS_PER_BATCH` | `20` | Maximum number of vouchers carried by one claim transaction |

### 5.3 Constraints that must be satisfied

```
TOPUP_THRESHOLD_MS   > voucher signature + /tick RTT          (millisecond-scale, to be measured)
CREDIT_PER_TICK_MS   > TOPUP_THRESHOLD_MS                (needs a clear margin)
GRACE_MS + WATCHDOG_SWEEP_MS = lower bound of stop paying to cut
DEPOSIT_TOPUP_ATOMIC > deposit on-chain wall-clock × per-second rate  (to be measured)
WITHDRAW_DELAY_SECS  > CLAIM_INTERVAL_SECS + on-chain latency + margin
```

### 5.4 Exposure comparison

| | Current (exact) | This design (batch-settlement) |
| --- | --- | --- |
| Buyer's per-payment exposure | One tick's 25 seconds' worth (0.001 USDC) | One tick's 1 second's worth (0.00004 USDC) |
| Buyer's additional exposure | None | Deposit locked; in the worst case must wait `WITHDRAW_DELAY_SECS` to recover it non-cooperatively |
| Seller's real-time exposure | 2-second grace period | One tick + sweep ≈ 1.1 seconds |
| Seller's new responsibilities | None | Deposit gate, claim deadline, voucher persistence |
| Stop paying to cut | 2–27 seconds | ≤ about 1.65 seconds |
| First-token latency | 7–14 seconds | About 6–7 seconds (measured, §12.4; originally estimated 1–2 seconds) |
| On-chain transactions | One every 25 seconds | 1 at start + one every 60 seconds + a refund at the end |

---

## 6. Components and file structure

```
src/
├── config.ts                    ✏️ add all §5.2 parameters
├── shared/
│   └── usdc.ts                  ✏️ add batch-settlement contract addresses
├── facilitator/                 🆕 self-hosted TS facilitator
│   └── main.ts                     x402Facilitator + four endpoints (§3.3)
├── server/
│   ├── payment.ts               ✏️ swap scheme, inject storage and receiverAuthorizerSigner
│   ├── channels.ts              🆕 deposit gate and balance conversion (pure functions, §6.2)
│   ├── channelStorage.ts        🆕 file / redis storage selection
│   ├── claimJob.ts              🆕 ChannelManager assembly and policy (§6.3)
│   ├── settleHook.ts            ✏️ carried over, now consumes voucher settlement results
│   ├── sessions.ts              — unchanged
│   ├── registry.ts              — unchanged
│   ├── watchdog.ts              — unchanged
│   ├── stream.ts                — unchanged
│   └── tokenSource.ts           — unchanged
└── agent/
    ├── wallet.ts                ✏️ swap client scheme + deposit policy + client hooks
    ├── heartbeat.ts             — almost unchanged (still POST /tick)
    ├── ledger.ts                — unchanged
    ├── sse.ts / render.ts       ✏️ render shows the deposit and the signed cap
    └── main.ts                  ✏️ trigger refund at the end
```

The x402-rs service in `docker-compose.yml` is removed, replaced by `npm run facilitator` (or a separately built local image).

### 6.1 Channel ledger (from the package, not defined ourselves)

```ts
interface Channel {
  channelId: string;
  channelConfig: ChannelConfig;      // payer, payerAuthorizer, receiver, receiverAuthorizer,
                                     // token, withdrawDelay, salt
  chargedCumulativeAmount: string;   // actual consumption recorded by the seller
  signedMaxClaimable: string;        // cap signed by the buyer
  signature: string;                 // signature of the latest voucher — lose it and you don't get paid
  balance: string;
  totalClaimed: string;
  withdrawRequestedAt: number;
  lastRequestTimestamp: number;
}
```

`ChannelStorage.updateChannel()` requires that "no concurrent insert may occur between the read and the write". `InMemoryChannelStorage` only guarantees this within a single JS runtime; multi-instance deployments need backend-level atomic conditional updates such as Redis Lua or SQL transactions. **The PoC is single-instance, but always uses persistable storage (§2.5.3).**

### 6.2 Seller gate (pure functions, the bulk of coverage)

```ts
canServe(channel, priceAtomic): boolean          // chargedCumulativeAmount + priceAtomic ≤ balance
remainingTicks(channel, priceAtomic): number     // floor((balance − chargedCumulativeAmount) / priceAtomic), minimum 0
needsDepositTopUp(channel, thresholdAtomic): boolean
withdrawDeadlineMs(channel, withdrawDelaySecs): number | null  // null when no withdrawal has been requested
```

All of them take `nowMs` passed in by the caller and never call `Date.now()` — the same principle as original spec §6.1, so that boundaries can be tested with a fake clock.

### 6.3 Claim policy

```ts
manager.start({
  claimIntervalSecs: config.claimIntervalSecs,
  settleIntervalSecs: config.settleIntervalSecs,
  refundIntervalSecs: config.refundIntervalSecs,
  maxClaimsPerBatch: config.maxClaimsPerBatch,
  shouldSettle: (ctx) => ...,          // transfer out only when the unclaimed amount exceeds a threshold, to save gas
  selectClaimChannels: (channels) => ...,  // channels with a pending withdrawal request take priority
  onError: (e) => logger.error("claim", ...),
});
```

**Withdrawal requests must jump the queue.** Channels returned by `getWithdrawalPendingSessions()` must be claimed immediately, not wait for the next `claimIntervalSecs`. This is where §2.5.2 gets implemented.

---

## 7. Error handling

| Scenario | Behavior |
| --- | --- |
| Deposit insufficient to pay for the next tick | Server sends no token, returns 402 with the channel state; the agent tops up the deposit and retries |
| Cumulative baseline out of sync (client and server disagree) | Server returns a corrective 402 with `channelState` / `voucherState`; the client verifies it with `processCorrectivePaymentRequired()` and re-signs |
| Invalid voucher signature / cap not increasing | Reject that tick, don't extend `paidUntil`, let the watchdog cut naturally |
| Buyer requests a withdrawal | Claim immediately; after a successful claim, keep serving as usual until the deposit is exhausted |
| Deposit fails to land on-chain | The agent gets a clear error; no session is created, no loss of funds |
| Claim fails to land on-chain | Log it and retry next period; if it still fails past `WITHDRAW_DELAY`, that is a loss of funds and must raise an alert |
| Facilitator not responding | Server refuses to start at startup (carried over from the original spec); during operation, deposit/claim fail but voucher verification is unaffected |
| Server restart | Channels are restored from persistent storage; all sessions are gone, and the agent reopens the stream |

---

## 8. Testing strategy and implementation order

Carries over the original spec's three-layer structure and 80% coverage threshold.

### Step 0 — Measurement spike (before any implementation)

The same discipline as the original spec: **the output is four numbers, not code to keep.**

1. Deposit on-chain wall-clock (determines `DEPOSIT_TOPUP_ATOMIC` and first-token latency)
2. `/tick` wall-clock for a single-tick voucher (determines `TOPUP_THRESHOLD_MS`, expected to be millisecond-scale)
3. Claim on-chain wall-clock and gas
4. The viem client's default `pollingInterval`, and the difference in deposit latency after setting it to 250ms

If item 2 is not millisecond-scale, `CREDIT_PER_TICK_MS = 1000` does not hold and must be re-evaluated.

### Layer 1 — Pure-function unit tests

All of `channels.ts` (§6.2), the claim policy's selection functions, and the existing `sessions.ts` tests carried over. Fake clock, no network. The deposit gate must have the following regression cases:

- Delivered service that has not been claimed still occupies the deposit
- A successful claim does not restore servable credit
- Allowed when remaining credit exactly equals one tick, rejected when it is 1 atomic short
- Servable credit is restored only after a top-up increases `balance`
- `remainingTicks` rounds down, and changes to `totalClaimed` do not affect the result
- When an inconsistent ledger makes `chargedCumulativeAmount > balance`, the remaining tick count is at minimum 0

### Layer 2 — HTTP contract tests (no chain)

With a fake facilitator (carrying over `tests/helpers/fakeFacilitator.ts`, extended with batch-settlement payload types):

- Sufficient deposit → each tick extends `paidUntil`
- Deposit exhausted → 402 and no token sent
- Cap not increasing / bad signature → rejected
- Stop paying → `event: cut` received within `GRACE_MS + WATCHDOG_SWEEP_MS`
- After a server restart, channels are restored from storage

### Layer 3 — On-chain smoke test (manual, not in CI)

`npm run smoke:channel`: deposit → 10 tick vouchers → claim → refund, printing the tx hash and gas for each stage.

### Implementation order

1. Spike (step 0)
2. `channels.ts` pure functions + tests
3. Self-hosted facilitator (`src/facilitator/main.ts`) + `/supported` integration
4. Swap the server billing layer's scheme + storage
5. Agent-side client scheme + deposit policy
6. Claim / refund scheduling
7. Parameter tuning and demo pacing

---

## 9. Known risks

| Risk | Description | Mitigation |
| --- | --- | --- |
| **Lost voucher signature** | Seller storage corrupted = that stretch of service goes unpaid | Always use persistent storage; don't make the claim period too long |
| **Withdrawal race** | If not claimed within `withdrawDelay`, the money can't be collected | Withdrawal requests jump the claim queue + alert; leave ample margin in `WITHDRAW_DELAY_SECS` |
| **Over-signed cap** | If the client signs a big cap at once, the buyer's exposure equals that cap | Add only one tick per tick (§2.4), and verify the increment in contract tests |
| **Deposit gate hole** | Service exceeding the deposit = seller loss of funds | `canServe()` is a pure function and must be tested; always check before sending a token |
| **Self-hosted facilitator has no ready-made HTTP layer** | Must be written ourselves; error handling may not match x402-rs | Treat x402-rs's `/verify` `/settle` `/supported` response shapes as authoritative and align contract tests to them |
| **Losing x402-rs's maturity** | Replaced with a self-written 60-line Express app | Only within PoC scope; the facilitator is for local demos only |
| **Multi-instance atomicity** | `InMemoryChannelStorage` only guarantees a single runtime | PoC is single-instance; document that multi-instance needs Redis Lua / SQL transactions |
| **One HTTP round trip per tick** | One tick per second = one `POST /tick` per second | Local RTT is 5.5ms, acceptable; re-evaluate if moving to a remote host |
| **Contract risk** | Deposit locked in a third-party contract | Testnet only, small amounts only (0.05 USDC) |

---

## 10. Acceptance criteria

1. `npm run facilitator` brings up the self-hosted facilitator, and `/health` and `/supported` respond normally
2. `npm run server` refuses to start when the facilitator is not running and gives a clear message (carrying over the original behavior)
3. After `npm run agent`: the first tick completes the deposit and streaming starts **within 8 seconds** (originally 2 seconds, rewritten based on §12.4's measured deposit time of 5.6–6.9 seconds)
4. During steady streaming, one tick per second, with the signed cap, the deposit, and cumulative consumption visible in the terminal
5. After the first Ctrl-C, vouchers stop being signed but the connection stays open; `event: cut` is received **within 2 seconds** and the server closes the connection (originally 1.5 seconds, relaxed per §12.9's upper-bound correction)
6. Lowering `DEPOSIT_ATOMIC` produces the same stream cutoff once the deposit is exhausted
7. After finishing, the refund succeeds and the unspent deposit returns to the buyer's wallet (verifiable on-chain)
8. **On-chain transaction count is decoupled from tick count (this design's core property).** After halving `CREDIT_PER_TICK_MS` (doubling the tick count, same stream duration) and re-running, the number of on-chain transactions **must not change**.

   The transaction count is determined only by the duration and §6.3's policy: deposit 0–1 transactions (0 when the channel already exists with enough deposit), claim `⌈duration ÷ CLAIM_INTERVAL_SECS⌉` transactions, settle `⌈duration ÷ SETTLE_INTERVAL_SECS⌉` transactions, and a final refund of 0–1 transactions. The refund carries any not-yet-claimed voucher, so the last claim can be merged into the refund. If claims are switched to idle-triggered, one stream can be compressed to **3 transactions** (deposit + refund including claim + settle).
9. Unit tests and contract tests pass, with coverage ≥ 80%

---

## 11. Open questions

- **Price per tick.** `40` atomic is merely the result of converting the current per-second rate. If it later tracks real GPU cost (e.g. $1/hour ≈ 278 atomic/second), the whole set of deposit parameters must be recalculated.
- **The trade-off of `WITHDRAW_DELAY_SECS = 900`.** For the buyer it is the upper bound on locked funds; for the seller it is the safety margin for claims. A value reasonable for both sides needs to be decided once there are real usage scenarios.
- **Whether claims should switch to "unclaimed amount exceeds a threshold" instead of a fixed period.** A fixed period is simpler when gas is cheap; mainnet should be primarily amount-threshold based.
- **Whether the agent needs to choose between `MAX_SPEND_ATOMIC` and the deposit.** Currently both coexist and their semantics overlap (the deposit itself is a hard cap).

---

## 12. Implementation deviation log

Decisions made during implementation that diverge from this document but were judged worth keeping. Each one states its reason, so it doesn't get "fixed" as a bug later.

### 12.1 `GET /tick` is a new endpoint (an exception to §2.2)

§2.2 says "endpoints and SSE completely unchanged", but in practice there is one more: `GET /tick`.

`@x402/evm`'s cooperative refund (`refundChannel`) first sends a **GET** probe to the resource URL to obtain
`PaymentRequirements`, then uses the `channelConfig` in it to build the refund payload. If only `POST /tick` were registered,
that probe would not get a 402 and the refund could not be initiated (§10.7 would fail outright).

So `POST /tick` and `GET /tick` are mounted on the same `tickResource`. `GET /tick` is only used to return 402,
and has no corresponding Express handler — a GET with a successful payment falls through to 404, which is expected behavior, not an omission.

### 12.2 `receiverAuthorizerSigner` made optional

§3.1 lists `receiverAuthorizerSigner` as a constructor parameter of the server scheme. The implementation makes it **optional**:

| `LLM_PROVIDER_AUTHORIZER_PRIVATE_KEY` | Who signs claim / refund authorizations |
| --- | --- |
| Set | The seller itself (consistent with §2.4, "`totalClaimed` is signed by the seller") |
| Left empty | Delegated to the facilitator, which advertises `receiverAuthorizer` in `/supported` |

Both are modes natively supported by the package; `validateFacilitatorSupport()` blocks startup when "no private key is set and the facilitator doesn't advertise one either".
It is optional because the former requires the seller to manage one more private key, and the PoC's facilitator is self-hosted anyway;
**in production the seller should hold it**, so that the trust model matches §2.4.

### 12.3 Added `WITHDRAW_POLL_MS` (a supplement to §5.2)

§6.3 requires withdrawal requests to jump the claim queue but does not define a polling frequency. The first version borrowed `WATCHDOG_SWEEP_MS` (100ms),
and every poll does a `readdir` of the whole channel storage and reads each file one by one — with `WITHDRAW_DELAY_SECS = 900`,
that is four orders of magnitude more frequent than needed. Changed to a separate parameter, defaulting to 5000ms, with zod enforcing
`WITHDRAW_POLL_MS < WITHDRAW_DELAY_SECS`.

### 12.4 §8 step 0 spike measurement results (2026-09-20)

Two real runs on Fuji, `npm run smoke:channel`, `FACILITATOR_POLLING_MS=250`:

| Measurement | Run 1 | Run 2 |
| --- | --- | --- |
| ① Deposit on-chain wall-clock | 5,581ms | 6,902ms |
| ② Single-tick voucher `/tick` wall-clock | 8–16ms | 7–14ms |
| ③ Claim on-chain wall-clock | 3,774ms | 3,822ms |
| Deposit gas | 160,492 | 139,524 |
| Claim gas (1 voucher, covering 11 ticks) | 74,876 | 57,776 |
| Refund wall-clock | 5,059ms (seller side) | 4,457ms (buyer side) |

④ viem's default `pollingInterval` for Fuji is **2000ms** (`avalancheFuji` has no `blockTime`,
so viem falls back to a default block time of 4000ms and halves it, clamped to 500–4000ms). This project sets it to 250ms.

**Conclusion 1: §2.1's core claim holds, with more margin than expected.** A single-tick voucher takes **7–16ms**,
about 500 times faster than the original per-tick on-chain 6.9–8.1 seconds. `CREDIT_PER_TICK_MS = 1000` fully stands,
and `TOPUP_THRESHOLD_MS = 300` has nearly 20x margin over a 16ms RTT — §5.3's first constraint is confirmed satisfied.

**Conclusion 2: §10.3's "streaming starts within 2 seconds" does not hold and must be rewritten.** The deposit measured **5.6–6.9 seconds**,
far above §4's estimate of 1–2 seconds. The two runs are close, and the second was even slower, so this is not caused by a cold start.
Swapping x402-rs's 7000ms polling for the self-hosted version's 250ms did help (the whole settle dropped from 6.9–8.1 seconds to about 3.8 seconds,
see the claim numbers), but the deposit path carries an additional cost of about 3 seconds — an ERC-3009 deposit does more work
than a plain transfer (139k–160k gas, versus 58k–75k for a claim).

So §5.4's "first-token latency 7–14 seconds → 1–2 seconds" should be corrected to **→ about 6–7 seconds**,
and §10.3's threshold should be changed to **within 8 seconds**. This does not affect this design's claim: **the quantity to prove is the exposure window from stopping payment to the cut,
not first-token latency**, and the former is already completely decoupled from the chain.

### 12.5 The facilitator's `/supported` once returned `signers: [null]`

`getAddresses()` in `toFacilitatorEvmSigner()` reads a **flat `client.address`**,
while viem's `WalletClient` only has `client.account.address`. Without that field, `/supported` returns
`{"signers":{"eip155:*":[null]}}`, the resource server deems the entire payload invalid during its startup sync,
and **every payment becomes a 502**.

This bug only shows up when the self-hosted facilitator is actually connected to the resource server — unit tests that use
a hand-written `getSupported` stand-in won't see it at all. `address` is now explicitly added in `src/facilitator/facilitator.ts`,
and `tests/facilitator.test.ts` asserts against a **really assembled** `x402Facilitator` that
signers must be real addresses.

### 12.6 A seller-side refund permanently invalidates the buyer's local record

The seller-side refund triggered by `REFUND_IDLE_SECS` (§5.2, §6.3) **does not notify the buyer**. After the refund, the on-chain balance goes to zero
and the server's channel record is deleted, but the buyer still has a local record saying "the balance is still 50000", so it keeps signing voucher-only
payments, each one blocked with `cumulative_exceeds_balance`.

The package's corrective recovery doesn't help — `processCorrectivePaymentRequired()` only recognizes
the two error codes `cumulative_amount_mismatch` and `cumulative_amount_below_claimed`;
`cumulative_exceeds_balance` is not among them. The measured result was that **the buyer gets permanently stuck on 402 unless someone manually deletes
the local channel file**.

Two fixes:

1. The client signer in `src/agent/wallet.ts` now uses `toClientEvmSigner(account, publicClient)`.
   Previously it was given only a bare `privateKeyToAccount()`, with no `readContract`, which `recoverChannel()` explicitly requires —
   meaning the on-chain recovery path never worked from the start.
2. When `payTick()` receives `cumulative_exceeds_balance`, it discards the local channel record and retries once,
   letting `recoverChannel()` rebuild it from the chain; only if the second attempt also fails is it treated as genuinely having no deposit, with a message pointing to the deposit rather than the faucet.

Verified on Fuji: after deliberately creating the desync with a seller-side refund, the next tick automatically re-deposits and succeeds
(before the fix it was a permanent 402).

> Also fixed a misleading heuristic along the way: the original `/insufficient|balance|funds/i` would classify the channel's
> `cumulative_exceeds_balance` as "insufficient USDC balance, go get funds from the faucet", when the wallet actually had 19.97 USDC.

### 12.7 `shouldSettle` has no amount threshold

§6.3's `shouldSettle` says "transfer out only when the unclaimed amount exceeds a threshold, to save gas". The implementation is
`({ pendingSettle }) => pendingSettle` (`src/server/claimJob.ts`): as long as there is a claimed balance not yet transferred out,
it settles once every `SETTLE_INTERVAL_SECS`, with no amount threshold.

Reason for keeping it: gas on Fuji is near zero, and the amount owed in one PoC stream is small (capped by the 0.05 USDC deposit);
adding a threshold would only mean no settle transaction is visible at the end of the demo. This is the same open question as §11's "whether claims should switch to an amount threshold";
**when moving to mainnet, both should be switched to amount-based together**.

### 12.8 Channel storage implements only the file version

§2.5.3 and §6 say "file or redis storage". The implementation only has file: `src/server/channelStorage.ts` directly returns the package's
`FileChannelStorage`, with no Redis option.

This does not violate §2.5.3's requirement (always use persistable storage, never `InMemoryChannelStorage`),
and the PoC only runs a single instance (§6.1). When moving to a multi-instance deployment, it must be replaced with storage that has backend-level atomic conditional updates
(Redis Lua or SQL transactions); simply pointing the file directory at a shared disk is not enough.

### 12.9 The upper bound from stopping payment to the cut is 1.65 seconds, not 1.35 seconds

§1.2, §4, and §5.4 originally said "an upper bound of about 1.35 seconds", derived by assuming the remaining credit at the moment payment stops is between 0 and 1 tick. That assumption missed the top-up timing:
the agent only tops up one tick when the remaining credit falls below `TOPUP_THRESHOLD_MS`, so **right after a top-up, the remaining credit is at most one tick + the threshold** (1000 + 300 = 1300ms).
If the buyer stops paying exactly at that moment, the cut comes only after 1.3 seconds + `GRACE_MS` + one sweep:

```
upper bound = CREDIT_PER_TICK_MS + TOPUP_THRESHOLD_MS + GRACE_MS + WATCHDOG_SWEEP_MS
            = 1000 + 300 + 250 + 100 = 1650ms
```

The original contract test stopped after paying a single tick (leaving exactly one tick remaining), so it couldn't hit this worst case; the "measured 1.45s" in commit `a55e459`'s message
also falls between 1.35 and 1.65 seconds, it just wasn't the worst case that time. `tests/batchSettlement.test.ts` now adds
a "stop paying right after a top-up" case, asserting that the cut time exceeds one tick and does not exceed the formula above.

The fix was to change the document rather than the parameters: §1.2, §4, and §5.4 now say 1.65 seconds, and §10.5's threshold is relaxed from 1.5 seconds to 2 seconds.
This is still an order of magnitude better than the original spec's 2–27 seconds, and does not affect this design's claim — none of the terms in the upper bound has anything to do with the chain.
If 1.5 seconds must be held later, `TOPUP_THRESHOLD_MS` can be lowered to 150 (the voucher round trip is 7–16ms, still about 10x margin).

---

## 13. Acceptance status (2026-10-14)

| §10 | Item | Status | Basis |
| --- | --- | --- | --- |
| 1 | facilitator `/health`, `/supported` | ✅ | `tests/facilitator.test.ts` asserts against a really assembled `x402Facilitator`; used in real Fuji runs |
| 2 | Server refuses to start when the facilitator isn't running | ✅ | `assertFacilitatorUp()` in `src/server/main.ts`, carrying over the original behavior |
| 3 | Streaming starts within 8 seconds | ⚠️ Partial | `smoke:channel` measured deposit at 5.6–6.9 seconds; first token not yet measured end to end with `npm run agent` |
| 4 | Terminal shows signed cap, deposit, cumulative consumption | ✅ | `src/agent/render.ts` (bal / cap / sum), `tests/render.test.ts` |
| 5 | `event: cut` within 2 seconds after Ctrl-C | ⚠️ Partial | `tests/batchSettlement.test.ts` verifies the upper bound with a fake facilitator for both the normal and worst case (stop paying right after a top-up); **not yet measured on Fuji** |
| 6 | Deposit exhaustion produces the same stream cutoff | ✅ | `tests/batchSettlement.test.ts` "returns 402 and creates no session when the deposit is exhausted and the buyer doesn't top it up" |
| 7 | Refund at the end, deposit returns to the buyer | ✅ | Two measured runs in §12.4 (seller side 5.1 seconds, buyer side 4.5 seconds) |
| 8 | On-chain transaction count decoupled from tick count | ❌ Not verified | Unit tests confirm only the first tick goes on-chain; **the real-run check of "halve `CREDIT_PER_TICK_MS`, re-run, compare on-chain transaction counts" has not been done yet** |
| 9 | Tests pass, coverage ≥ 80% | ✅ | 21 files, 167 tests passing; line coverage 96.82% |

The remaining items 3, 5, and 8 all require manually running `npm run agent` on Fuji (which spends testnet USDC and the facilitator's AVAX), and are not in CI.
