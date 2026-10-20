# DripLLM

> Lets small inference providers with no billing infrastructure charge machine customers by the second: keep paying and the inference keeps flowing; stop paying and the line gets cut.

DripLLM is a minimal runnable project. A buyer agent holds open an SSE stream, and each USDC micropayment buys a slice of streaming time, topping up automatically when its credit runs low. Once it stops paying, its credit burns down, the grace period expires, and the seller server actively cuts the connection. Payments go through the [x402](https://x402.org) protocol, with on-chain verification and settlement handled by a self-hosted facilitator on the Avalanche Fuji testnet.

## The problem

A small LLM provider that wants to charge money first has to build a whole stack: accounts, payment integration, invoicing, credit and collections, refund disputes, fraud prevention. **That cost doesn't scale with the number of customers; it's a fixed barrier to entry.** Big companies can amortize it; one person running a self-hosted model can't.

With this approach, a provider needs only a receiving address and a piece of middleware. No accounts, no invoices, no credit risk, no chargebacks, and global from day one.

### Why per second, not per token

Per-token pricing is how big companies price once the hardware has been abstracted away. **For a small self-hosted provider, the real cost is the time the GPU is occupied.** One person running one card pays in seconds. For this audience, billing by time fits the cost structure better than billing by token.

### Why plain per-request x402 isn't enough

For an ordinary request/response API, per-request payment is already enough: no payment means a 402, no response, and zero exposure. **This project adds nothing in that scenario.**

What has no off-the-shelf answer is **streaming**. For an inference that runs for several minutes, "one request" isn't a natural billing unit, which leaves two bad options:

| Approach | Who bears the risk |
| --- | --- |
| Prepay the whole thing | The buyer bears counterparty risk (pays, and the seller disappears) |
| Serve first, bill later | The seller bears credit risk (delivers, and the buyer never pays) |

The third way: **slice time into ticks, so neither side is ever exposed to the other by more than one tick.**

### What this demo proves isn't "can it be cut off"

"No money, no service" is common to every billing model. Only one quantity is meaningful: **how large the exposure window is between the buyer stopping payment and service actually stopping.**

Agent wallets built on session-based pre-authorization make the opposite trade-off: approve a budget and a time limit up front, and the agent spends autonomously within that box, gaining the convenience of not asking every time. The cost is that until the authorization is revoked, the entire budget is genuinely exposed. The two solve different layers: **session authorization governs "whether the buyer may spend"; DripLLM governs "how fast the seller can pull back when the other side stops paying."**

### A hard boundary

The barrier doesn't disappear; it **changes sides**. Providers no longer have to build a billing system, but every customer needs a wallet holding USDC. For human customers that's a dealbreaker; for agent customers it isn't, since agents are provisioned by code in the first place. That's why this belongs to agent payments rather than general SaaS billing.

## How it works

The data flow of one tick:

1. On startup the agent sends its first `POST /tick` (carrying a sessionId it generates itself in the `X-Drip-Session` header) without payment → the server responds `HTTP 402`, with the price, payment asset, `receiverAuthorizer`, and `withdrawDelay` in the `PAYMENT-REQUIRED` header (base64 JSON; the body is an empty object)
2. **First tick**: the agent signs an ERC-3009 authorization that deposits funds into the payment channel contract, attaches the first cumulative voucher, puts both in the `PAYMENT-SIGNATURE` header, and resends. The facilitator submits it on-chain (it pays the gas, so the agent needs no AVAX)
3. **Every tick after that**: the agent signs only an **off-chain** voucher, with cap = consumed + one tick. No on-chain transaction, no gas, millisecond-level
4. After a successful settle, the server creates or extends the session in the `onAfterSettle` hook; `/tick` returns `{ sessionId, accepted: true }`, and channel state travels in the `PAYMENT-RESPONSE` header
5. The agent uses that sessionId to open an SSE connection to `GET /stream` (just this one for the whole run), and tokens start flowing
6. Every `CREDIT_EVENT_MS` (default 250ms) the server pushes an `event: credit`; when the agent sees remaining time below `TOPUP_THRESHOLD_MS` (default 300ms), it sends another `POST /tick` to push `paidUntil` forward. Top-ups are driven by credit events, not by the agent's own timer
7. Off the hot path, the seller **periodically** takes the latest voucher on-chain to claim, and settles the claimed balance to the receiving address; at shutdown, the unused deposit is refunded

**On-chain transaction count is decoupled from tick count:** a voucher records a **cumulative cap**, so 1,000 ticks need only the last voucher submitted, at the same gas cost as 1 tick. The only on-chain transactions in a stream are "opening deposit + periodic claim/settle + refund at shutdown."

**Core mechanism:** the server's watchdog periodically sweeps the session ledger; any session that is overdue and past its grace period receives `event: cut`, and the server closes the connection right after.

### Why a long-lived SSE connection

If every tick were an independent request, "cutting the stream" would just be the agent breaking out of its own loop. On screen you couldn't tell a server-enforced stop from the agent quitting voluntarily, and the server would never exercise any power at all.

With a long-lived connection, the agent is still connected and still wants more, yet the line gets cut. That makes enforcement visible, and it's also what lets Ctrl-C serve as the demo's trigger.

### Three endpoints, only one of them paid

| Endpoint | x402 | Responsibility | Who calls it, and when |
| --- | --- | --- | --- |
| `POST /tick` | Paid | Pay once → create or extend the session; returns 409 if the sessionId has already been cut (payment cancelled, nothing charged) | Agent: once at startup; then whenever the remaining time in `event: credit` drops below the threshold |
| `GET /stream` | Free | SSE; pushes `token` / `credit` / `cut` while the session is alive (sessionId goes in the `X-Drip-Session` header) | Agent: opened once after the first successful `/tick`; on 404, retries once after 300ms |
| `GET /health` | Free | Returns `{ ok, sessions }` (current session count) | Not called by the agent; for tests and manual checks |

On startup, the seller server calls the **facilitator's** `/health` to confirm the facilitator is running; if there's no response, it exits immediately.

`/stream` being free isn't a loophole: **a session only exists once it has been paid for**, so there is no path to free tokens. This keeps the x402 middleware in the per-request position it's naturally good at, and the SSE path never touches payment logic.

## Architecture

```
   buyer agent                          seller server                      facilitator
      │  ── POST /tick (deposit + voucher) ─▶ │  ─── verify / settle ─────────▶ │ ──▶ Fuji: deposit into contract
      │  ◀─── {sessionId, accepted} ──────────┤                                 │
      │  ──── GET /stream ──────────────────▶ │
      │  ◀═══ token token token ══════════════╡   watchdog: now > paidUntil + grace
      │  ──── POST /tick (voucher only) ────▶ │   off-chain signature check, ms-level, no chain
      │  ◀─── event: cut ─────────────────────┤   ✂ server cuts the line
      │                                       │  ─── periodic claim / settle ─▶ │ ──▶ Fuji: seller claims
      │                                       │  ─── refund at shutdown ──────▶ │ ──▶ Fuji: deposit refunded
```

| Component | Location | Responsibility |
| --- | --- | --- |
| Buyer agent | `src/agent/` | Testnet wallet, deposit policy, re-signing a voucher every tick, spending cap, two-stage Ctrl-C |
| Seller server | `src/server/` | x402 middleware on `/tick`, deposit gatekeeping, session ledger, watchdog cuts, SSE streaming, claim/settle/refund scheduling |
| Facilitator | `src/facilitator/` | Self-hosted TypeScript version; verifies payments and submits deposit / claim / settle / refund on-chain |

On-chain verification and settlement are handed to the facilitator, and the payment channel uses x402's already-deployed batch-settlement contract, so there's no contract of our own to write.

### Two ledgers

`session` tracks "how much longer this SSE stream can live" (`paidUntilMs`, `tickCount`; its lifetime is one stream);
`channel` tracks "how much deposit this buyer has left" (`balance`, `totalClaimed`, `chargedCumulativeAmount`; spans many streams).
Cutting a session doesn't affect the channel; once the deposit runs out, no session can be extended.

### Three rules the seller has to enforce itself

The protocol won't do this for you; it all lives on the server side:

1. **Deposit gatekeeping**: before sending tokens, the server must confirm `consumed + this tick's amount ≤ deposit`. [channels.ts](src/server/channels.ts) is a pure function, and [settleHook.ts](src/server/settleHook.ts) re-checks every tick
2. **Claim deadline**: the buyer can initiate a withdrawal, and the seller must claim the latest voucher on-chain within `WITHDRAW_DELAY_SECS`; [claimJob.ts](src/server/claimJob.ts) moves withdrawal requests to the front of the queue and raises an alert when the deadline is missed
3. **State persistence**: the signature on the latest voucher exists only in the seller's hands; lose it and the money is genuinely uncollectable. Real runs always use file storage, and `CHANNEL_STORAGE_DIR` is listed in `.gitignore`

## Tech stack

### Language and runtime

- **Node.js + TypeScript (strict, `noUncheckedIndexedAccess`), ESM**: run directly with `tsx`, no build step
- **Express 5**: the seller server's HTTP layer; all three endpoints, `/tick`, `/stream`, and `/health`, sit on it
- **zod**: every environment variable and billing parameter is validated by [src/config.ts](src/config.ts) before injection; nothing is hard-coded

### Payment protocol: x402 v2

- **Server side** ([src/server/payment.ts](src/server/payment.ts)): `@x402/express` mounts the x402 middleware on `/tick`; `BatchSettlementEvmScheme` from `@x402/evm/batch-settlement/server` verifies vouchers, keeps the books, and persists the channel; `BatchSettlementChannelManager` runs claim / settle / refund off the hot path
- **Agent side** ([src/agent/wallet.ts](src/agent/wallet.ts)): `@x402/fetch` intercepts the 402 and automatically signs a payment and resends; `@x402/evm/batch-settlement/client` handles the deposit policy, re-signing a voucher every tick, and corrective-402 recovery when the cumulative baseline falls out of sync; **viem** does the EIP-712 signing and serves as the buyer's wallet layer
- **Settlement:** scheme `batch-settlement` (payment channel). The deposit goes through **ERC-3009 `receiveWithAuthorization`**, so **the agent wallet needs no AVAX**; all gas is paid by the facilitator's signer

#### Who signs the claim / refund authorization

`receiverAuthorizer` is the key that authorizes the seller to claim. If `LLM_PROVIDER_AUTHORIZER_PRIVATE_KEY` is set, **the seller signs it itself**; if left empty, signing is delegated to the facilitator, in which case the facilitator must advertise its own `receiverAuthorizer` on `/supported`, or the server refuses to start. The PoC runs either way, and delegation is reasonable with a self-hosted facilitator; in production, the seller should hold the key.

### Chain: Avalanche Fuji testnet

- Avalanche itself is an L1 blockchain; this project uses the testnet (Fuji) of its built-in EVM chain, the **C-Chain**, CAIP-2 identifier `eip155:43113`, EIP-1559
- **Asset:** testnet USDC `0x5425890298aed601595a70AB815c96711a31Bc65`, 6 decimals
- Avalanche L1s (application-specific chains, formerly called subnets) aren't used; ERC-20 settlement on the C-Chain is enough

#### Why Avalanche

For high-frequency streaming that bills by the second and cuts in real time, Avalanche solves the hardest physical constraints of a micropayment gateway:

- **Sub-second finality, so the opening deposit lands fast enough.** Snowman consensus reaches final settlement in about 0.8-1.5 seconds (measured 2026-09-11: about 1 second per block). Since switching to a payment channel, only the first tick waits on the chain and every tick after that is an off-chain voucher, so cut speed is **completely independent of the chain's properties**
- **Very low gas, so opening and claiming are both cheap.** One settle measured about 85,720 gas. With batched claims, on-chain transaction count is decoupled from tick count, which is what makes mainnet economics work (going on-chain every tick doesn't work on mainnet, since gas is on the same order as one tick's revenue)
- **Mature EVM compatibility.** Fully EVM-compatible, so EIP-712 signature verification and standard ERC-20 calls carry over directly. x402's batch-settlement contract is deterministically deployed at the same address on every chain, so a self-hosted facilitator doesn't have to reinvent the wheel
- **A scaling path via a dedicated chain.** If inference volume explodes and micropayment frequency climbs, a dedicated Avalanche L1 (formerly a Subnet) can be provisioned with a custom fee token, or even zero fees, so congestion on the public network doesn't hurt inference latency

### Facilitator: self-hosted TypeScript version

- [x402-rs](https://github.com/x402-rs/x402-rs) **doesn't support batch-settlement** (its README marks even upto and deferred as Planned), so we use `x402Facilitator` from `@x402/core/facilitator` instead, registering the scheme from `@x402/evm/batch-settlement/facilitator`
- `x402Facilitator` is just a class with no HTTP server. [src/facilitator/app.ts](src/facilitator/app.ts) adds four endpoints, `/verify`, `/settle`, `/supported`, and `/health`, shaped to match x402-rs; start it with `npm run facilitator` or [docker-compose.yml](docker-compose.yml)
- This also fixes x402-rs's polling problem: it hard-codes `is_local` to `false`, so alloy waits for receipts using its 7000ms default polling interval, and the config file has no option to change it. The self-hosted version builds its own viem client; **viem's default for Fuji is 2000ms**, and this project sets `FACILITATOR_POLLING_MS=250`
- The facilitator's signer must bring its own AVAX; it submits all four transaction types: deposit / claim / settle / refund

### Testing and verification

- **Vitest + supertest**: pure-function unit tests + HTTP contract tests (against a fake facilitator), none of which touch the chain
- 80% coverage threshold (v8 provider, excluding entry points such as `main.ts`)

> ⚠️ **Testnet only.** Get AVAX from the Core Wallet console and USDC from the Circle faucet. Never use real assets. The facilitator's signer wallet must bring its own AVAX to pay for gas.

A few easy pitfalls; glance at these before implementing:

- **Don't use `x402-express`.** That's v1: deprecated, receiving security patches only, and both its API shape and network identifiers differ from v2. Most third-party tutorials are still written for v1; always treat the v2 examples in the `coinbase/x402` repo as authoritative.
- **Don't mix up the two numbers on a voucher.** `maxClaimableAmount` is the **cumulative cap** the buyer signs (= the buyer's exposure); `chargedCumulativeAmount` is the **actual consumption** the seller records. The contract only guarantees the amount won't exceed the cap, not that it equals the service delivered. That's why the client must re-sign every tick and raise the cap by only one tick. Signing one big cap up front is handing the whole deposit over to the seller's self-restraint.
- **On Fuji, the USDC EIP-712 domain name is `USD Coin`, not `USDC`.** Only Base Sepolia uses `USDC`. Getting it wrong makes signature verification fail, and the error message won't point you here.

## Parameters

### Stream billing

| Parameter | Value | Description |
| --- | --- | --- |
| `CREDIT_PER_TICK_MS` | `1000` | Streaming time bought by one tick |
| `TOPUP_THRESHOLD_MS` | `300` | Sign the next voucher when remaining credit drops below this |
| `GRACE_MS` | `250` | Grace period after going overdue before the server cuts |
| `WATCHDOG_SWEEP_MS` | `100` | Cut sweep interval |
| `PRICE_PER_TICK_ATOMIC` | `40` | 0.00004 USDC |
| `MAX_SPEND_ATOMIC` | `50000` | 0.05 USDC, the agent's spending cap |

### Payment channel

| Parameter | Value | Description |
| --- | --- | --- |
| `DEPOSIT_ATOMIC` | `50000` | 0.05 USDC ≈ 1,250 ticks ≈ 21 minutes |
| `DEPOSIT_TOPUP_ATOMIC` | `5000` | Top up the deposit when it drops below this |
| `WITHDRAW_DELAY_SECS` | `900` | Waiting period for a buyer's non-cooperative withdrawal |
| `CLAIM_INTERVAL_SECS` | `60` | Seller's batch claim interval |
| `SETTLE_INTERVAL_SECS` | `300` | Interval for transferring out the claimed balance |
| `REFUND_IDLE_SECS` | `120` | How long a channel can sit idle before it's proactively refunded |
| `MAX_CLAIMS_PER_BATCH` | `20` | Maximum number of vouchers in one claim transaction |
| `WITHDRAW_POLL_MS` | `5000` | Polling interval for moving withdrawal requests to the front of the queue |
| `CHANNEL_STORAGE_DIR` | `.dripllm/channels` | Where voucher signatures are persisted; listed in `.gitignore` |

Required constraints are enforced by zod at startup: `TOPUP_THRESHOLD_MS < CREDIT_PER_TICK_MS`, `WITHDRAW_DELAY_SECS > CLAIM_INTERVAL_SECS`, `WITHDRAW_POLL_MS < WITHDRAW_DELAY_SECS`.

The agent tops up **when its credit is about to run out**, not on a fixed interval. If it "paid every N seconds" while "each payment bought N seconds," network and settlement latency would make the credit drift downward tick by tick, and after a few ticks the stream would cut itself off with nobody intervening. All parameters are validated with zod by [src/config.ts](src/config.ts) before injection; nothing is hard-coded.

### Fuji measurements, 2026-09-20

| Metric | Measured |
| --- | --- |
| `/tick` round trip for a single-tick voucher | **7-16ms** (vs. 6.9-8.1 seconds for going on-chain every tick, roughly 500x faster) |
| Opening deposit on-chain | **5.6-6.9 seconds** |
| Claim on-chain | **3.8 seconds** · gas 58k-75k (1 voucher covering 11 ticks) |
| Deposit gas | 140k-160k |
| viem's default `pollingInterval` for Fuji | 2000ms (this project uses 250ms) |

`TOPUP_THRESHOLD_MS = 300` leaves nearly 20x headroom over a 16ms round trip, so `CREDIT_PER_TICK_MS = 1000` holds up.

> ⚠️ **First-token latency didn't come down to the originally estimated 1-2 seconds; it measures about 6-7 seconds.** The deposit has to wait on the chain, and an ERC-3009 deposit is much more expensive than a plain transfer (gas 140k-160k, vs. 58k-75k for a claim). This doesn't affect the quantity this project sets out to prove: **the exposure window from stopping payment to the cut is now fully decoupled from the chain**; only the opening transaction still goes on-chain.

## Quick start

```bash
# 1. Install dependencies
npm install

# 2. Configure environment variables (buyer wallet, facilitator signer, facilitator URL, etc.)
cp .env.example .env

# 3. Get testnet funds: the facilitator signer needs AVAX for gas, the buyer agent needs USDC

# 4. Start the facilitator
npm run facilitator

# 5. Start the seller server
npm run server

# 6. In another terminal, start the buyer agent
npm run agent
```

If the facilitator isn't up, the server refuses to start and tells you why.

## What to watch in the demo

- Each tick's payment, tx hash, and cumulative spend (USDC), plus the continuously flowing tokens
- On the server side, one voucher log line per tick; after payment stops, the watchdog prints a grace-period warning and the cut summary, so it's obvious who cut the line

  ```
  [hook] · session 7f3a · tick #12 · voucher · deposit covers 1238 more ticks
  [watchdog] ⚠ session 7f3a · paid time used up, grace period 250ms
  [watchdog] ✂ session 7f3a · stream cut · 12 ticks total · $0.00048
  [stream] · session 7f3a was cut by the server
  ```

  A tick is only 1 second, so during steady streaming the remaining credit naturally hovers within 1 second. The server therefore doesn't print a countdown each time; it warns only once, when the credit actually runs out.

- On the agent side, each tick shows the deposit balance (`bal`), the signed cap (`cap`), and cumulative consumption (`sum`);
  only the first tick has a tx hash, and every one after that shows `voucher`

- **First Ctrl-C:** the agent stops paying but **stays connected** and keeps reading the stream
- **The moment of the cut:** time from stopping payment to the cut = remaining credit + `GRACE_MS` + one sweep interval. Right after a top-up, remaining credit is at most one tick + the top-up threshold, so the upper bound is ≈ **1.65 seconds**, and the agent shows that the server has closed the connection
- After being cut, the agent automatically refunds the unused deposit and exits; pressing Ctrl-C a second time before the cut refunds and exits immediately

The first Ctrl-C not disconnecting is what makes the whole demo work: the agent is still connected and still waiting, and it's the server that cuts the line. Lower `MAX_SPEND_ATOMIC` and the agent stops paying on its own when it hits the spending cap, producing exactly the same cut.

## Testing

```bash
npm test              # Pure-function unit tests + HTTP contract tests, none touch the chain
npm run smoke         # Runs 3 ticks against real Fuji and prints tx hashes (manual, not in CI)
npm run smoke:channel # deposit → 10 voucher ticks → claim → refund, printing each stage's tx and gas (manual, not in CI)
```

The contract tests use a fake facilitator whose **bookkeeping and EIP-712 signature verification are real**; it only skips going on-chain.
So "no tokens once the deposit runs out," "reject if the cap doesn't increase," and "reject a bad signature" are all genuinely proven, not just "the HTTP call went through."
80% coverage threshold (v8 provider, excluding entry points such as `main.ts`).

`npm run smoke:channel` sends **real Fuji transactions** and spends testnet USDC and AVAX.
It only needs the facilitator running first; the script starts the server in-process itself, so it can trigger the claim manually at the right moment.

## Project status

Proof of concept (PoC). The inference backend is currently a canned token stream; hooking up a real LLM later only means swapping out the `TokenSource` implementation, with no changes to the billing layer.

For design decisions and details, see the [design doc](docs/superpowers/specs/2026-09-06-dripllm-design.md).

## License

MIT
