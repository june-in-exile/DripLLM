# DripLLM Batch Settlement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-tick `exact` payments with persistent batch-settlement channels while preserving the existing `/tick`, `/stream`, session, and watchdog flow.

**Architecture:** Use the batch-settlement client/server/facilitator implementations already shipped by `@x402/evm@2.25.0`. Keep session credit in the existing registry, persist server and client channel ledgers with the package file-storage adapters, and run claims/settles/refunds through `BatchSettlementChannelManager` outside the `/tick` hot path.

**Tech Stack:** TypeScript, Express 5, Vitest, viem 2, `@x402/core@2.25.0`, `@x402/evm@2.25.0`, `@x402/express@2.25.0`, `@x402/fetch@2.25.0`.

**Spec:** `docs/superpowers/specs/2026-09-12-dripllm-batch-settlement.md`

## Global Constraints

- Preserve `POST /tick`, `GET /stream`, `GET /health`, `X-Drip-Session`, and the token/credit/cut SSE events.
- Use one voucher per one-second tick; never pre-sign a larger cumulative allowance.
- Use persistent channel storage in runtime code; in-memory storage is test-only.
- Keep Fuji (`eip155:43113`) and ERC-3009; do not add mainnet support or custom contracts.
- Keep manual onchain smoke/spike work outside CI and do not execute it without explicit authorization.
- Preserve unrelated working-tree changes, especially logo files.

---

### Task 1: Channel arithmetic and configuration

**Files:**
- Modify: `src/server/channels.ts`
- Modify: `tests/channels.test.ts`
- Modify: `src/config.ts`
- Modify: `tests/config.test.ts`
- Modify: `src/shared/usdc.ts`
- Modify: `tests/usdc.test.ts`

**Interfaces:**
- Produces: `canServe`, `remainingTicks`, `needsDepositTopUp`, and `withdrawDeadlineMs` pure functions.
- Produces: batch timing, deposit, claim, settle, refund, storage, RPC, and facilitator configuration in `AppConfig`.

- [ ] Add failing boundary tests for top-up detection and withdrawal deadlines, then run `npx vitest run tests/channels.test.ts` and confirm the missing exports fail.
- [ ] Implement the two pure functions with bigint-safe arithmetic and explicit `nowMs` input where time is involved.
- [ ] Add failing config/default/constraint tests and batch contract-address tests.
- [ ] Change defaults to 1-second ticks, 40 atomic per tick, 250ms grace, 100ms sweep, and add the §5.2 channel settings.
- [ ] Run `npx vitest run tests/channels.test.ts tests/config.test.ts tests/usdc.test.ts`.

### Task 2: Persistent channel storage and claim policy

**Files:**
- Create: `src/server/channelStorage.ts`
- Create: `src/server/claimJob.ts`
- Create: `tests/channelStorage.test.ts`
- Create: `tests/claimJob.test.ts`

**Interfaces:**
- Produces: `createServerChannelStorage(rootDir): ChannelStorage`.
- Produces: `prioritizeWithdrawalPending(channels)` and `startClaimJob(...)`.

- [ ] Write failing tests proving records survive a new file-storage instance and withdrawal-pending channels sort first.
- [ ] Wrap `FileChannelStorage` and implement pure claim selection.
- [ ] Start `BatchSettlementChannelManager` with configured claim/settle/refund intervals, batch size, logging, and withdrawal priority.
- [ ] Run `npx vitest run tests/channelStorage.test.ts tests/claimJob.test.ts`.

### Task 3: Self-hosted TypeScript facilitator

**Files:**
- Create: `src/facilitator/app.ts`
- Create: `src/facilitator/main.ts`
- Create: `tests/facilitator.test.ts`
- Modify: `package.json`
- Modify: `docker-compose.yml`

**Interfaces:**
- Produces: `createFacilitatorApp(facilitator)` with `/health`, `/supported`, `/verify`, and `/settle`.
- Produces: `npm run facilitator` backed by a viem Fuji signer with a 250ms polling interval.

- [ ] Write failing HTTP tests against a deterministic facilitator double.
- [ ] Implement the HTTP adapter and preserve x402 response shapes and error status handling.
- [ ] Compose `x402Facilitator` with the batch-settlement facilitator scheme and replace the x402-rs compose service.
- [ ] Run `npx vitest run tests/facilitator.test.ts` and `npx tsc --noEmit`.

### Task 4: Server payment scheme and background settlement

**Files:**
- Modify: `src/server/payment.ts`
- Modify: `src/server/routes.ts`
- Modify: `src/server/settleHook.ts`
- Modify: `tests/helpers/fakeFacilitator.ts`
- Modify: `tests/contract.test.ts`

**Interfaces:**
- Produces: a batch-settlement `x402ResourceServer` using persistent `ChannelStorage`.
- Produces: route startup that starts the channel manager while leaving session/watchdog APIs unchanged.

- [ ] Convert the fake facilitator wire contract and write a failing test that the 402 advertises `batch-settlement` plus receiver-authorizer/withdraw-delay data.
- [ ] Register `BatchSettlementEvmScheme`, expose its manager, and start claim/settle/refund jobs from `buildApp`.
- [ ] Adapt settle-hook payer/transaction handling to deposit and voucher responses without changing session credit semantics.
- [ ] Run `npx vitest run tests/contract.test.ts` outside the restricted socket sandbox.

### Task 5: Agent channel client, display, and refund

**Files:**
- Modify: `src/agent/wallet.ts`
- Modify: `src/agent/heartbeat.ts`
- Modify: `src/agent/render.ts`
- Modify: `src/agent/main.ts`
- Modify: `tests/e2e.test.ts`
- Create: `tests/wallet.test.ts`

**Interfaces:**
- Produces: a persistent `BatchSettlementEvmScheme` client with a 50,000-atomic initial deposit and 5,000-atomic top-up strategy.
- Produces: client helpers for channel status and cooperative refund.

- [ ] Write failing tests that two consecutive payments are deposit then voucher and cumulative allowance rises by exactly 40 atomic.
- [ ] Replace the exact scheme with batch settlement, file storage, hooks, and corrective-402 support supplied by the package.
- [ ] Return channel balance/signed ceiling/charged cumulative values from successful tick handling and render them.
- [ ] On normal shutdown or a second interrupt, request cooperative refund without changing the first-interrupt stop-paying behavior.
- [ ] Run `npx vitest run tests/wallet.test.ts tests/e2e.test.ts` outside the restricted socket sandbox.

### Task 6: Smoke command, docs, and full verification

**Files:**
- Create: `scripts/smoke-channel.ts`
- Modify: `.env.example`
- Modify: `README.md`
- Modify: `package.json`

**Interfaces:**
- Produces: `npm run smoke:channel` for manual deposit → vouchers → claim → refund verification.

- [ ] Add the manual smoke runner and document required Fuji credentials and its state-changing nature.
- [ ] Update local-run instructions from Docker x402-rs to `npm run facilitator`.
- [ ] Run `npx tsc --noEmit`.
- [ ] Run `npm test` and confirm all files pass with at least 80% coverage.
- [ ] Review `git diff` against every acceptance criterion and report any item requiring the manual Fuji smoke run.
