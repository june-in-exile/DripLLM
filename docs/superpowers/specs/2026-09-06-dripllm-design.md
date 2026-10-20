# DripLLM Design Document

**Date:** 2026-09-06
**Status:** Finalized, implementation in progress
**Scope:** Proof of concept (PoC)

---

## 1. Goal

**Let small inference providers with no billing infrastructure charge machine customers by the second, without either side having to extend credit to the other.**

Demonstrate it with a minimal runnable system: a buyer agent hangs on an inference stream and keeps paying; the moment it stops paying, the seller server actively cuts the connection.

### 1.1 The problem being solved

A small LLM provider that wants to charge has to build a whole stack first: an account system, payment integration, invoicing, credit and collections, refund disputes, fraud prevention. **That cost does not scale with the number of customers; it is a fixed barrier** — a large company can amortize it, one person running a self-hosted model cannot.

On the DripLLM path, the provider only needs a receiving address plus a piece of middleware. No accounts, no invoices, no credit risk, no chargebacks, and it is global from day one.

### 1.2 Why "per second" and not "per token"

Per-token billing is how large companies price once they have abstracted the hardware away. **The real cost for a small self-hosted provider is the time the GPU is occupied** — one person running one card, their cost is seconds. Billing by time fits this audience's cost structure better than billing by token; it is not a simplification made for demo convenience.

### 1.3 Why native per-request x402 alone is not enough

For an ordinary request/response API, per-request payment already solves the problem: no payment means a 402, no response, and zero exposure. **This project adds nothing in that scenario.**

What has no ready-made answer is **streaming** — for an inference that runs several minutes, "one request" is not a natural billing unit. That leaves only two bad options:

| Approach | Who bears the risk |
| --- | --- |
| Charge the whole thing upfront | The buyer bears counterparty risk (pays, and the other side runs off) |
| Deliver first, charge later | The seller bears credit risk (delivers everything, and the other side does not pay) |

DripLLM's answer is a third option: **slice time into ticks of `CREDIT_PER_TICK_MS`, so neither side's exposure to the other ever exceeds one tick.**

### 1.4 What this demo proves is not "can it be cut"

"No money, no service" is common to every billing model and not worth a demo. Only one quantity is meaningful: **from the moment payment stops to the moment service actually stops, how large is the exposure window in between.**

Agent wallets built on session pre-authorization (such as Kite Agent Passport) make the opposite trade-off — approve a budget and a time limit up front, and the agent spends autonomously within that box, gaining the convenience of "no need to ask every time"; the cost is that until revocation, exposure to the entire budget is real.

The two do not conflict; they solve different layers: **session authorization governs "whether the buyer may spend"; DripLLM governs "how fast the seller can pull back when the other side stops paying."**

### 1.5 A hard boundary: machine customers, not human customers

The barrier does not disappear; it **switches sides**: the provider no longer has to build a billing system, but **every customer must have a wallet holding USDC**.

For human customers this is fatal — nobody opens a wallet and buys USDC just to use a small model. For agent customers it is not: agents are provisioned by code in the first place, and handing one a wallet is one line of code.

That is why this project sits under the topic of agent payments rather than general SaaS billing.

### 1.6 Non-goals

- No real LLM inference (the PoC uses a canned token stream; the interface is swappable)
- No scaling to multiple buyers or multiple sessions
- No web frontend; the demo is two terminals side by side
- No mainnet, no real assets
- No smart contracts of our own; on-chain verification and settlement are left to the facilitator

---

## 2. Core design decisions

### 2.1 The cut must be executed by the server (key decision)

Two shapes were considered:

| Option | What the cut looks like | Problem |
| --- | --- | --- |
| One independent request per tick | The agent breaks out of its own loop | On screen you cannot tell "server enforcement" from "agent voluntarily stopping"; the server never exercises any power at all |
| **Long-lived SSE connection + payment heartbeat (adopted)** | The server actively calls `res.end()` | The agent is still connected and still wants more, but the line is cut — enforcement is visible |

**Adopt the long-lived SSE connection.** Ctrl-C works as the demo trigger only under this option.

### 2.2 Three endpoints, only one charges

| Endpoint | x402 | Responsibility |
| --- | --- | --- |
| `POST /tick` | Charged | Pay once → create or extend a session. Returns `{ sessionId, accepted: true }` |
| `GET /stream?sessionId=` | Free | SSE; emits tokens while the session is alive |
| `GET /health` | Free | For the demo script and startup checks |

`/stream` being free is not a loophole: **a session exists only if it has been paid for**, and a session is created by the hook only after the `POST /tick` payment settles successfully (§2.5), so there is no path to free tokens. This design keeps the x402 middleware in the per-request position it is naturally good at, and the SSE side never touches payment logic.

#### 2.2.1 Endpoint details

- **The sessionId is generated by the agent** with `crypto.randomUUID()` and sent on every `POST /tick` in the `X-Drip-Session` header. Rationale in §2.5 — session creation and extension happen in the hook after settle completes, and the hook cannot go back and rewrite an already-finalized response body, so the id must be supplied by the caller.

- **A cut sessionId cannot be reused (tombstone); the handler blocks it before settlement.** The server keeps a short-lived (`TOMBSTONE_TTL_MS`) set of cut ids. If the `POST /tick` handler finds that the incoming id hits that set, it **returns 409**.

  The key is timing: the middleware order is verify → handler → settle, and in the dist, `if (res.statusCode >= 400)` calls `cancellationDispatcher.cancel({ reason: "handler_failed" })` to **cancel settlement**. So when the handler returns 409 the payment has not yet gone on-chain, and the agent is not charged. After receiving 409, the agent just generates a new UUID and retries.

  Rationale: the id is generated by the client. If, after receiving `event: cut`, the agent kept paying with the same UUID, a session the watchdog had already cleared would be revived under the same id, with `tickCount` and `spentAtomic` recomputed from zero, so the settlement summary at the end of the demo would undercount.

  **Do not switch to "accept the payment and issue a new id" instead** — that would require writing the new id into the response body, and the body is finalized and buffered when the handler calls `res.end()`, so the hook cannot change it (same root cause as the txHash, see §2.5). The agent would open the SSE with the old id and get a 404.

  The agent should also proactively switch to a new UUID after receiving `cut`; do both layers.

- **`POST /tick` carrying a sessionId that does not exist (and is not tombstoned):** treated as creating a new session. The payment has already happened; refusing would mean taking the money and not delivering the goods.

- **The `POST /tick` response does not include the txHash.** The tx hash is written by the middleware into the `X-PAYMENT-RESPONSE` header after settle. How the agent reads it (note that you must pass in a getHeader function; it is not a no-argument call):

  ```ts
  import { x402HTTPClient } from "@x402/core/client";
  // getPaymentSettleResponse(getHeader: (name: string) => string | null | undefined): SettleResponse
  const settle = new x402HTTPClient(client)
    .getPaymentSettleResponse((n) => response.headers.get(n));
  const txHash = settle.transaction;
  ```

- **Three SSE event types:**
  - `event: token` — `data` is a chunk of inference text
  - `event: credit` — `data` is `{ "remainingMs": n, "grace": bool, "tickCount": n, "spentAtomic": "..." }`, sent every `CREDIT_EVENT_MS`
  - `event: cut` — `data` is `{ "sessionId": "...", "reason": "payment_lapsed", "tickCount": n, "spentAtomic": "..." }`; the connection is closed immediately after it is sent

- **`remainingMs` may be negative**, and `grace: true` once the grace period begins. If it were clamped at 0, the agent could not distinguish "credit about to run out" from "already overdue, inside the grace period", and the terminal output in §4 is exactly meant to present those two phases separately.

- **The first tick is not driven by `event: credit`.** Although top-up timing is driven by credit events, when tick #1 happens the session does not yet exist and the SSE is not yet open. The agent's startup sequence is: generate UUID → `POST /tick` (creates the session) → open the SSE with the returned sessionId → from then on, top-ups are driven by `event: credit`.

### 2.3 A credit model, not a fixed alarm clock

One payment buys a slice of **streaming time**, and the agent tops up **when the credit is about to run out**, rather than paying at a fixed interval.

If you "pay every N seconds" and "one payment buys N seconds", latency makes the credit drift downward tick by tick, and after a few ticks the system cuts the stream on its own without the user intervening. The top-up condition is credit falling below `TOPUP_THRESHOLD_MS`, driven by the SSE `event: credit`.

**The main source of drift is on-chain settlement, not the network.** See §2.5. This yields a hard constraint:

```
TOPUP_THRESHOLD_MS > settle wall-clock
CREDIT_PER_TICK_MS > TOPUP_THRESHOLD_MS (with a clear margin)
```

The agent must start topping up **at least one settle cycle** before the credit runs out, otherwise payment will never catch up with consumption. The measured settle time determines these two parameters, which is why the implementation order in §8 starts with a measurement spike.

### 2.4 The SSE connection object does not go into the session record

`Session` is read-only plain data; the Express `Response` object lives in a side table `Map<sessionId, Response>`.

Rationale: the correctness of the cut depends entirely on the timing logic of the session ledger. Keeping it as pure functions + plain data is what makes it possible to test every boundary exhaustively with a fake clock without starting HTTP.

---

### 2.5 Session creation and extension happen in `onAfterSettle`, not in the Express handler

**Confirmed from the dist source of `@x402/express@2.25.0`: settle sits on the critical path of the response.** The middleware hijacks `res.writeHead/write/end/flushHeaders` and buffers everything, runs `processSettlement` (on-chain) only after `await endPromise` (waiting for the handler to call `res.end`), and only at the very end, in `finally`, replays the buffered response. **The client receives not a single byte before settle completes.**

So the wall-clock of `POST /tick` = 402 challenge RTT + signing + verify RTT + on-chain settlement on Fuji.

If `paidUntil = now + CREDIT` were computed inside the handler, the agent would receive the response only after settle completes, and the streaming time it actually bought would be `CREDIT − settle latency`. That is exactly the drift §2.3 is trying to avoid, except the source is settlement rather than the network.

**Solution:** move session creation and extension into `x402ResourceServer.onAfterSettle(hook)`.

- `paidUntil` is counted from **the moment settle completes**, so settlement latency no longer eats into the credit
- The hook's `SettleResultContext.result` carries a `SettleResponse`, whose `transaction` is the tx hash (required). The payer address must not come from `result.payer`; see §2.6 for why
- The hook fires only when settle succeeds, so §7's "a failed settle does not extend `paidUntil`" holds naturally, with no compensating rollback needed
- The hook can read the original request via `transportContext`. The full path (traced three levels deep in the dist):

  ```ts
  // AfterSettleHook receives { ...settleContext, result, transportContext }
  // transportContext is HTTPTransportContext = { request: HTTPRequestContext, responseBody, responseHeaders }
  // HTTPRequestContext.adapter is an HTTPAdapter, whose getHeader(name) goes straight through to Express's req
  const sessionId = ctx.transportContext.request.adapter.getHeader("X-Drip-Session");
  ```

**But the hook cannot rewrite the response body.** The body is finalized and buffered when the handler calls `res.end()`; the hook runs after that and returns `Promise<void>`. Therefore:

- The `POST /tick` body returns only `{ sessionId, accepted: true }` (the sessionId was sent by the agent, so the handler already knows it)
- **The tx hash goes in a header**: after settle, the middleware writes `X-PAYMENT-RESPONSE` via `res.setHeader`, and the agent reads it with `x402HTTPClient.getPaymentSettleResponse()`
- **Credit goes over SSE**: the `event: credit` event reports `remainingMs`, and the agent uses it to decide when to top up

**Limitation:** the hook can only be attached via `paymentMiddleware(routes, server, ...)` or `paymentMiddlewareFromHTTPServer`; `paymentMiddlewareFromConfig` cannot take it. In v2.25.0 all three functions take positional parameters rather than an options object, and `syncFacilitatorOnStart` is the 5th positional parameter.

**Known residual risk:** if settle succeeds but the hook throws, the agent gets a 200 but `/stream` returns 404. The PoC accepts this; the agent retries the first `/stream` 404 once, then gives up and reports a clear error.

### 2.6 Payer identity comes from `authorization.from`, never from `result.payer`

A session is bound to the address of its first payment, and extension is refused when a later tick's payer does not match (§2.2.1). **This address must come from `authorization.from` in the payment payload.**

```ts
type SettleResponse  = { ...; payer?: string; transaction: string; ... };  // payer is optional
type VerifyResponse  = { ...; payer?: string; ... };                       // likewise optional

type ExactEIP3009Payload = {
  signature?: `0x${string}`;
  authorization: {
    from: `0x${string}`;   // required, and part of the EIP-712 signature
    ...
  };
};
```

If binding used `result.payer` and the facilitator did not populate that field, the first payment would write `undefined` into the session, every later payer would likewise be `undefined`, and `undefined === undefined` is always true — **the protection fails completely, without producing a single error message**. This is more dangerous than no binding at all, because the document would lead implementers to believe it is already blocked.

`authorization.from` is a required field, and the EIP-712 signature the facilitator just verified is a signature over exactly it, so it is cryptographically bound and does not depend on whether the facilitator bothers to populate some optional field.

**Value rule:**

```
payer = authorization.from ?? result.payer
if both are empty → throw immediately, refuse to create the session, never bind undefined
```

The declared type of `paymentPayload.payload` is `Record<string, unknown>` and must be cast to `ExactEIP3009Payload`. This cast should be concentrated in a single function in `settleHook.ts`, and the payer should be made a pure-function input to `upsertSession`, so the mismatch case can be verified directly in layer 1 tests.

## 3. Technology choices (all verified)

### 3.1 Packages

Use **x402 protocol v2**: `@x402/express`, `@x402/core`, `@x402/evm`, `@x402/fetch`, `viem`.

> **Do not use `x402-express`.** v1 is deprecated and receives only security patches. v2 differs in both API shape and network identifiers. Note that third-party docs such as thirdweb's are mostly still stuck on v1 usage.

Network identifiers use CAIP-2 format: `eip155:43113` (not v1's `"avalanche-fuji"`).

**Version pinned to `2.25.0`.** Every statement in this document about the packages' internal behavior is based on the actually installed `2.25.0` dist. The `main` branch of `coinbase/x402` differs from the published version (see §3.3); do not infer the published version's behavior from the source on GitHub.

### 3.2 Chain and asset (Avalanche Fuji testnet)

| Item | Value |
| --- | --- |
| Chain ID | 43113 (CAIP-2: `eip155:43113`) |
| RPC | `https://api.avax-test.network/ext/bc/C/rpc` |
| USDC contract | `0x5425890298aed601595a70AB815c96711a31Bc65` |
| EIP-712 domain name | `USD Coin` |
| EIP-712 domain version | `2` |
| decimals | `6` |
| EIP-3009 | Support confirmed (`authorizationState()` responds) |
| AVAX faucet | Core Wallet console |
| USDC faucet | Circle faucet |

The `name` / `version` / `decimals` / EIP-3009 values above were all confirmed by reading directly from the Fuji chain via `eth_call`.

> **`name` is `USD Coin`, not `USDC`.** On Base Sepolia the USDC domain name is `USDC`; on Fuji it is `USD Coin`. This value is part of the EIP-712 domain; getting it wrong makes signature verification fail, and the error message will not point here.

### 3.3 The price must specify the asset explicitly (server side)

`@x402/evm@2.25.0` exports `DEFAULT_ASSETS` (along with `findDefaultAsset` and `getDefaultAsset`). The EVM networks that table actually lists:

```
eip155:1, 14, 50, 51, 137, 143, 988, 1328, 1329, 2201, 4326, 8453,
31611, 31612, 36900, 38833, 42161, 42220, 43114, 72344, 84532,
181228, 190415, 421614, 723487, 11142220
```

**`eip155:43114` (Avalanche mainnet) is in the table; `eip155:43113` (Fuji) is not.** So `price: "$0.001"` combined with `network: "eip155:43113"` cannot resolve an asset address.

`price` also accepts an `AssetAmount` object, so we use the explicit form:

```ts
price: {
  amount: "1000",                                    // 0.001 USDC (6 decimals)
  asset: "0x5425890298aed601595a70AB815c96711a31Bc65",
  extra: { name: "USD Coin", version: "2" },
}
```

> **Watch out for version differences.** In the `main` branch of `coinbase/x402` this table is named `DEFAULT_STABLECOINS` and contains no Avalanche networks at all; the published `2.25.0` names it `DEFAULT_ASSETS` and includes mainnet 43114. Go by the installed version; do not infer from the GitHub source.

### 3.3.1 The client side must allow the Fuji asset

The `x402Client`'s `spendControls` **by default only allows assets that `findDefaultAsset` recognizes**. Since Fuji is not in `DEFAULT_ASSETS`, the default configuration refuses to pay outright, and the error message will not point here.

It must be allowed explicitly:

```ts
spendControls: {
  allowedAssets: [{
    network: "eip155:43113",
    asset: "0x5425890298aed601595a70AB815c96711a31Bc65",
    maxAmountPerPayment: "1000",   // integer atomic units, not "$1"
  }],
}
```

`maxAmountPerPayment` here also serves as a hard cap per payment, and together with the agent's own cumulative spending cap (`MAX_SPEND_ATOMIC`) forms two independent lines of defense.

### 3.4 Facilitator: self-hosted x402-rs

No hosted service is used. The hosted instance at `facilitator.x402.rs` does not support Fuji; thirdweb's hosted offering requires a third-party account and its docs are stuck on v1.

A self-hosted x402-rs `config.json` is configured generically by CAIP-2 chain id; adding an `eip155:43113` entry is enough to support Fuji, without waiting for upstream support. x402-rs fully supports protocol v2 (scheme `v2-eip155-exact`).

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

Docker: `ghcr.io/x402-rs/x402-facilitator`, mount config.json at `/app/config.json`, expose 8080.
Endpoints: `/verify`, `/settle`, `/supported`, `/health`.

**The facilitator's signer wallet must hold its own AVAX to pay gas.**

---

## 4. Runtime sequence

```
agent                          server                      facilitator
  │                              │                              │
  ├─ POST /tick ────────────────▶│                              │
  │◀────────── 402 + price/asset ┤                              │
  ├─ POST /tick + X-PAYMENT ────▶├─ verify ────────────────────▶│
  │                              │◀─────────────────────── ok ──┤
  │                              ├─ settle ────────────────────▶│──▶ Fuji
  │                              │◀──────── SettleResponse ─────┤
  │                              ├─ onAfterSettle: new session  │
  │                              │   paidUntil = now + CREDIT   │
  │◀── {sessionId, accepted} ────┤   (response flushed only now)│
  ├─ GET /stream?sessionId ─────▶│                              │
  │◀════ token / credit events ══╡
  │                              │
  ├─ POST /tick (on event:credit▶│ paidUntil = max(now, paidUntil) + CREDIT
  │  when remainingMs < threshold│  (likewise computed only after settle completes)
  │◀════ token token token ══════╡
  │                              │
  │  ^C stop paying, stay open   │
  │◀════ token token ════════════╡  credit burns out + keeps streaming within 2s grace
  │                              │  watchdog: now > paidUntil + GRACE_MS
  │◀──── event: cut ─────────────┤
  │◀──── [connection closed] ────┤
```

**Interval from stopping payment to disconnect = credit remaining at the moment payment stops + `GRACE_MS`.**

Using the finalized values in §5 (CREDIT 25s / TOPUP 15s / GRACE 2s), credit at the moment payment stops falls between 15 and 25 seconds, so **the interval from stopping payment to disconnect is 2-27 seconds**. Measured on 2026-09-06: after payment stopped, tokens kept flowing until the credit was used up; during the grace period the agent displayed a negative credit countdown (measured -141ms → -1643ms), and then the server cut the line.

The variability of this range is deliberately kept — it makes each demo slightly different, so it looks like credit is really burning rather than a script running.

The server must print the countdown to the terminal so the audience understands those few seconds are not a hang:

```
[server] session 7f3a · credit 1.2s
[server] session 7f3a · credit 0.4s
[server] session 7f3a · ⚠ overdue, grace 2.0s
[server] session 7f3a · ✂ cutting stream
```

---

## 5. Parameters

> **Finalized (2026-09-06, measured per the §8 measurement spike).** 402 challenge RTT 5.5ms; full tick wall-clock 7.4-10.6s (three measurements, dominated by on-chain settle). The threshold is the measured maximum × 1.4 (15s), leaving a 4.4s margin; credit is set to 25s to balance demo pacing. Re-measure if Fuji latency changes significantly.

| Parameter | Finalized value | Description |
| --- | --- | --- |
| `CREDIT_PER_TICK_MS` | `25000` | Streaming time bought by one payment (measured settle 7.4-10.6s; needs margin) |
| `TOPUP_THRESHOLD_MS` | `15000` | Top up when credit falls below this value (> max measured settle of 10.6s) |
| `GRACE_MS` | `2000` | Grace period after going overdue before the server cuts the line |
| `PRICE_PER_TICK_ATOMIC` | `1000` | 0.001 USDC |
| `MAX_SPEND_ATOMIC` | `50000` | 0.05 USDC, about 50 ticks |
| `TOKEN_INTERVAL_MS` | `120` | Interval between tokens, simulating streaming pace |
| `CREDIT_EVENT_MS` | `500` | Interval between `event: credit` sends |
| `WATCHDOG_SWEEP_MS` | `250` | Period of the single sweep timer |
| `TOMBSTONE_TTL_MS` | `60000` | How long cut sessionIds are retained, to block reuse |

Constraints that must hold (see §2.3):

```
TOPUP_THRESHOLD_MS > settle wall-clock
CREDIT_PER_TICK_MS > TOPUP_THRESHOLD_MS (with a clear margin)
GRACE_MS sets the lower bound of "stop paying to cut"
```

All parameters are validated with zod in `src/config.ts` and then injected; nothing is hardcoded. Tests shorten the cycle by injecting small constants (see §8).

## 6. Components and file structure

```
DripLLM/
├── docker-compose.yml            one-command facilitator startup
├── facilitator/config.json       eip155:43113 + v2-eip155-exact
├── .env.example
├── src/
│   ├── config.ts                 zod validation of all env
│   ├── shared/
│   │   ├── usdc.ts               Fuji asset constants + atomic conversion
│   │   └── logger.ts             structured terminal output
│   ├── server/
│   │   ├── main.ts               bootstrap
│   │   ├── payment.ts            x402 middleware assembly (explicit AssetAmount)
│   │   ├── settleHook.ts         onAfterSettle — the only entry point for session create/extend
│   │   ├── payer.ts              extracts payer identity from the payload (§2.6)
│   │   ├── sessions.ts           immutable session ledger (pure functions)
│   │   ├── registry.ts           sole holder of the store (§6.3.1)
│   │   ├── watchdog.ts           single sweep timer + cut
│   │   ├── stream.ts             SSE handler
│   │   ├── tick.ts               POST /tick
│   │   └── tokenSource.ts        TokenSource interface + canned implementation
│   └── agent/
│       ├── main.ts               bootstrap + two-stage SIGINT
│       ├── wallet.ts             viem signer + x402Client
│       ├── ledger.ts             spending cap and running total (pure functions)
│       ├── sse.ts                hand-written SSE parsing (Node has no EventSource, see §6.5)
│       ├── heartbeat.ts          top-up loop (driven by event: credit)
│       └── render.ts             terminal output
└── tests/
```

Each file is expected to stay within 100–150 lines.

### 6.1 Session ledger interface

```ts
export type Session = Readonly<{
  id: string;
  payer: string;          // from authorization.from, see §2.6; later ticks must match
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
remainingMs(session, nowMs):              number      // may be negative, see §2.2.1
inGrace(session, nowMs, graceMs):         boolean
```

All are pure functions: `id`, `payer`, `nowMs`, and `txHash` are all passed in by the caller, and no function calls `crypto.randomUUID()` or `Date.now()`. This is the precondition for what §2.4 calls "testing exhaustively with a fake clock".

`upsertSession` merges the former `createSession` / `extendSession`: the only difference between them is whether the id is in the store, and §2.2.1 already defines the behavior for both cases as the same (create or extend), so splitting them into two functions would only force the caller into an extra branch.

### 6.2 Token source interface

```ts
export interface TokenSource {
  open(): AsyncIterable<string>;
}
```

The PoC implementation cycles through a piece of canned text. Hooking up a real LLM later only requires replacing this file's implementation; the billing layer needs no changes.

### 6.3 Watchdog

A **single** `setInterval(WATCHDOG_SWEEP_MS)` sweeps all sessions, rather than one timer per connection.

The cut steps must follow this order:

1. **Take the session object out first** (`tickCount` and `spentAtomic` are needed later)
2. `removeSession(store, id)` from the ledger, and record the id in the tombstone set
3. Send `event: cut`, with a payload using the values taken in step 1
4. `res.end()`

Step 1 cannot be skipped: the `event: cut` payload carries `tickCount` and `spentAtomic`; if they were read after removal, both would be `undefined` — and that is exactly the settlement summary on the last line of the demo.

Why step 2 comes before step 4: `res.end()` triggers Express's `close` event, which goes through the same handler as "the agent disconnecting on its own". By removing from the ledger first, the `close` handler can use "is this id still in the ledger" to tell the two apart — still present means the agent disconnected itself; already gone means the watchdog cut it. The logs can then label it correctly, and that is precisely the distinction the whole demo sets out to prove. The cleanup itself is idempotent.

#### 6.3.1 How the immutable store is held

The ledger is immutable; every update produces a new object. Therefore the `close` handler, the watchdog, and the hook **must never capture the store itself in a closure**, or they will forever read the stale snapshot from registration time, and the "is it still in the ledger" check above would all come out inverted.

All access goes through a single holder:

```ts
// registry.ts — the only mutable cell; its contents are still immutable data
const registry = { current: new Map() as SessionStore };
export const getStore = () => registry.current;
export const setStore = (next: SessionStore) => { registry.current = next; };
```

Handlers always read fresh via `getStore()` and never accept the store as a captured parameter. The pure functions in §6.1 still take a store parameter and return a new store — mutability is confined to this one cell, and the pure functions and their tests are unaffected.

### 6.4 The agent's two-stage SIGINT

- First Ctrl-C: `paying = false`, print "Stopped paying, connection still open", **keep reading the stream**
- Second Ctrl-C: actually exit

The first stage is what makes the whole demo work — the agent is still connected, still waiting, and the line is cut by the server.

---

### 6.5 SSE parsing (agent side)

Measured on Node v26.5.0: `typeof EventSource === "undefined"`; it is only available with the `--experimental-eventsource` flag. The PoC does not depend on experimental flags; instead it gets a `ReadableStream` via `fetch` and parses it by hand.

`src/agent/sse.ts` must handle: chunk boundaries may fall in the middle of an SSE frame (frames are separated by `\n\n`), so it must keep a buffer of the undigested tail, append to it each time, and then split. This file has its own pure-function unit tests (see §8) that feed in deliberately fragmented chunk sequences to verify frame reconstruction.

## 7. Error handling

| Situation | Behavior | User message |
| --- | --- | --- |
| Facilitator not responding at startup | Server refuses to start | `facilitator not responding (localhost:8080) — run docker compose up first` |
| Facilitator fails mid-run | `/tick` returns 503; the session naturally goes overdue and is cut | `Payment service down, stream about to disconnect` |
| Settle fails (facilitator has no gas) | `onAfterSettle` does not fire, the session is not created/extended; the middleware discards the handler's body and sends its own 402 instead | `Settlement failed: facilitator wallet is short on AVAX` |
| Agent has insufficient USDC | Settle reverts | `Insufficient USDC wallet balance — get some from the Circle faucet` |
| sessionId does not exist or has expired | `/stream` returns 404 | `Session does not exist or has expired; please pay first` |
| Second SSE opened for the same sessionId | Returns 409, refused | Prevents one payment from feeding multiple streams |
| Agent connection drops | Clear the session and its side-table entry | (Prevents watchdog resource leaks) |
| Settle succeeds but the hook throws | Agent gets 200 but `/stream` returns 404 | Agent retries once then gives up: `Session creation failed; the payment was settled but did not take effect` |
| Tick's payer does not match the session | The hook refuses to extend and logs it; **cannot return 403**, because the hook runs after the response is finalized. The session is no longer renewed and is eventually cut by the watchdog | Server log: `Session belongs to another payer; refusing to extend` |
| Both `authorization.from` and `result.payer` are empty | Throw immediately, do not create the session (see §2.6) | `Cannot confirm payer identity; refusing to create session` |
| Tick's sessionId hits a tombstone | Handler returns 409, middleware cancels settlement, **no charge** | Agent generates a new UUID and retries |
| env missing or malformed | zod fails at startup | **List all** missing items at once, rather than reporting only the first |
| Spending cap exhausted | Agent stops paying but stays connected | `Reached cap of $0.05, stopped paying — waiting for server to cut the stream` |

---

## 8. Test strategy and implementation order

TDD: write tests first (RED), then implement (GREEN), then refactor. The coverage threshold is 80%, applied to layers 1 and 2; the spike and layer 3 are excluded from the calculation.

### Step 0 — Measurement spike (**completed 2026-09-06**, data below)

Measured results: 402 challenge RTT = 5.5ms (does not touch the chain); full tick wall-clock = 10.6s / 8.6s / 7.4s. §5 parameters finalized from the measurements (TOPUP 15s / CREDIT 25s). The measurement was folded into the per-tick timing of `scripts/smoke.ts`; no separate throwaway script was built.

**The output is three numbers, not code to keep.**

Start the facilitator, write a throwaway script of about 30 lines, run one full tick against real Fuji, and measure:

1. 402 challenge RTT
2. verify RTT
3. **settle wall-clock** (the most critical)

Finalize §5's `CREDIT_PER_TICK_MS` and `TOPUP_THRESHOLD_MS` from the measured values, and go back to update the seconds in the §4 sequence diagram and §10 acceptance criterion #5.

Rationale in §2.5: settle sits on the critical path of the response, and how long it takes directly determines whether the parameters are viable. Writing ahead without knowing this number is betting that the demo won't cut its own stream. Throw the script away once it has run.

### Layer 1 — Pure-function unit tests (bulk of coverage)

vitest + fake timers, millisecond scale.

- `sessions.test.ts` — `upsertSession` create/extend/payer mismatch, `remainingMs` (including negative values), `inGrace`, `expiredSessions`, `removeSession`
- `payer.test.ts` — `authorization.from` takes priority, `result.payer` as fallback, **must throw rather than bind undefined when both are empty** (§2.6)
- `watchdog.test.ts` — grace period boundary: exactly within grace is not cut, 1ms past it is cut; cut order (read values → remove → cut → end); `event: cut` payload contains the correct `tickCount` / `spentAtomic`
- `registry.test.ts` — after the store is updated, a previously obtained accessor still reads the new value (the stale-snapshot problem in §6.3.1)
- `ledger.test.ts` — spending cap boundary: whether to pay when the remaining amount exactly equals one payment's price
- `sse.test.ts` — frame reconstruction: chunk split in the middle of `\n\n`, a single chunk containing multiple frames, a long frame spanning three chunks
- `usdc.test.ts` — atomic conversion precision, rejection of overflow and negative values
- `config.test.ts` — various missing and malformed env values

### Layer 2 — HTTP contract tests (no chain)

supertest + **fake facilitator** (Express; `/verify`, `/settle`, `/supported` simply return success, and `/settle` returns a fake `transaction` string).

> **This layer uses the real clock, not fake timers.** Once real socket I/O is involved, fake timers make pending I/O never resolve. Instead, inject very small constants via config (`CREDIT_PER_TICK_MS=300`, `TOPUP_THRESHOLD_MS=100`, `GRACE_MS=120`) so the complete "pay → stream → cut" cycle finishes within 1 second. This also incidentally verifies that the parameters really are injected rather than hardcoded.

What is verified:

- No `X-PAYMENT` → 402
- Valid payment → `onAfterSettle` fires, session is created, body returns `{ sessionId, accepted: true }`
- `X-PAYMENT-RESPONSE` header exists and contains `transaction`
- `/stream` with unknown sessionId → 404
- Second SSE opened for the same sessionId → 409
- Tick with mismatched payer → 403
- SSE receives `event: credit` and `remainingMs` decreases
- Overdue → receives `event: cut` and the connection actually closes
- Agent disconnects on its own → session removed from the ledger, and the log labels it as an agent-side disconnect (not a watchdog cut)
- Paying again with a cut sessionId → response carries a **different** new sessionId, and the old id's `tickCount` does not revive
- `event: credit` reports a negative `remainingMs` and `grace: true` during the grace period

> **`paymentMiddleware`'s `syncFacilitatorOnStart` defaults to `true`** (the 5th positional parameter), and calls the facilitator's `/supported` at startup. The fake facilitator must implement this endpoint, or the server cannot start in tests.

### Layer 3 — On-chain smoke test (manual)

`npm run smoke`: run 3 ticks against real Fuji and output the tx hashes. Not in CI, not counted toward coverage.

### Implementation order

```
0. Measurement spike (throwaway) → finalize §5 parameters
1. sessions / usdc / config / sse   pure functions, no I/O
2. watchdog + stream                fake TokenSource, no payment
3. fake facilitator + contract test layer   full flow, no chain
4. real x402 middleware + onAfterSettle
5. real facilitator + Fuji          smoke test
```

The payment layer goes last: every item in steps 1–3 can be verified without touching the chain.

## 9. Known risks

| Risk | Description | Mitigation |
| --- | --- | --- |
| **Settle duration determines parameter viability** | Settle sits on the response's critical path (§2.5). If the measured wall-clock approaches or exceeds `TOPUP_THRESHOLD_MS`, top-ups will never catch up with consumption, and the demo will cut its own stream | The §8 step 0 measurement spike precedes all implementation; `TOPUP_THRESHOLD_MS` must be greater than the measured value |
| Facilitator EOA nonce queuing | Under high-frequency settles the facilitator signer uses sequential nonces, so consecutive settlements may queue or collide | Observable already in the spike phase; if it happens, increase `CREDIT_PER_TICK_MS` to lower the frequency |
| Package's published version differs from the `main` branch | `DEFAULT_ASSETS` / `DEFAULT_STABLECOINS` differ in naming and contents between the two (§3.3) | Pin version `2.25.0`; base all behavioral judgments on the installed dist, not the GitHub source |
| Third-party docs lag behind | Most x402 tutorials still use v1 usage | Always go by the v2 examples in the `coinbase/x402` repo and the actual dist |
| Facilitator runs out of gas | Self-hosting means maintaining the AVAX balance yourself | Error message points clearly to this cause (see §7) |
| Problems with the EIP-3009 path | The primary transfer method depends on Fuji USDC's `transferWithAuthorization` | permit2 is a usable fallback, but **has preconditions**, see §9.1 |
| Hook throws, so payment is settled but no session is created | See the residual risk in §2.5 | Accepted for the PoC; agent retries once then reports a clear error |
| Bearer sessionId for `/stream` | Authorization = possessing the token (a UUID, not enumerable); the holder can occupy the single connection until the credit expires, but cannot extend it (blocked by payer binding) | Accepted for the PoC. Transport uses the `X-Drip-Session` header rather than the query string, eliminating proxy/access-log leakage; the threat model is local machine/testnet |

### 9.1 Preconditions for the permit2 fallback

The exact scheme in `@x402/evm` has two transfer methods: `eip3009` (default) and `permit2`. This project uses `eip3009`, but if that path has problems, permit2 is a usable fallback on Fuji — **however, it cannot be switched on just by changing a setting**.

Deployment status confirmed by measurement (Fuji, `eth_getCode`):

| Contract | Address | bytecode |
| --- | --- | --- |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | 9152 bytes |
| x402ExactPermit2Proxy | `0x402085c248EeA27D92E8b30b2C58ed07f9E20001` | 2913 bytes |

> In `@x402/evm@2.25.0` the proxy address is a **single string constant** `x402ExactPermit2ProxyAddress`, not a per-chain lookup table — it is a deterministic deployment, at the same address on every chain.

**Precondition: the payer wallet must first make a one-time on-chain `approve` of that token to the Permit2 contract**, and only then can individual transfers be authorized with off-chain signatures. The library's API shape states this directly:

```ts
// createPermit2ApprovalTx(tokenAddress) → { to, data }; the caller sends the transaction itself
const tx = createPermit2ApprovalTx("0x...");
await walletClient.sendTransaction({ to: tx.to, data: tx.data });
```

This leads to two consequences:

- **It does not affect the settle latency analysis in §2.5.** This approve is one-time and does not enter the hot path of each tick.
- **But the agent wallet will need AVAX.** With `eip3009` the agent needs no AVAX at all (gas is the facilitator's business), which is why §7 currently has no "agent short on AVAX" row. **Once the permit2 fallback is enabled, that row must be added**, and the quick start in §1 needs an extra "get AVAX for the agent wallet" step.

## 10. Acceptance criteria

1. `docker compose up` brings up the facilitator, and `/health` responds normally
2. `npm run server` brings up the seller server; when the facilitator is not running it refuses to start and gives a clear message
3. After `npm run agent`, the terminal shows: each tick's payment, the tx hash read from `X-PAYMENT-RESPONSE`, cumulative spend (USDC), and continuously flowing tokens
4. After the first Ctrl-C, the agent stops paying but stays connected, and tokens keep flowing for a few seconds
5. After "credit remaining at the moment payment stops + `GRACE_MS`" (2-27 seconds under the finalized parameters, **measured and passed on 2026-09-06**), the server actively cuts the line; the agent side shows that the connection was closed by the server, and the server side labels it as a watchdog cut
6. After lowering `MAX_SPEND_ATOMIC`, the agent hits the cap, stops paying automatically, and produces the same stream cut result
7. Unit tests and contract tests pass, coverage ≥ 80%
8. ~~§8 step 0 spike has been run~~ **Completed 2026-09-06**; §5 parameters finalized from measurements
