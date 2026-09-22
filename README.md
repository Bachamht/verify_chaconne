# Chaconne Verify — StockProof + RWA Guard

**OKX Dev Day 2026 · Build a Company (primary track) · built on top of the existing Chaconne project**

> A **trade-task service for agents** on tokenized US stocks: plan what is actually achievable, keep watching while conditions move, execute only inside limits the user signed once, and hand over evidence anyone can re-check offline.

> **Two names, one product.** The live site brands itself **Chaconne Agent** (its job, stated plainly: let an AI agent trade for you). These review materials and the OKX AI listing keep the project name **Chaconne Verify**, which is the name ASP #13803 is registered and under review as. Nothing technical differs between them: same domain, same API paths, same contracts, same package names. "Verify" also remains the name of the capability itself (verification report, evidence bundle, `verify-bundle` CLI).

- Product entry (独立入口): `https://verify.chaconne.xyz/`
- OKX AI service: ASP **#13803 "Chaconne Verify"**, A2MCP service *StockProof Trade Verification* → `POST https://verify.chaconne.xyz/a2mcp/verify`
- Guard contract (X Layer mainnet, 196): [`0x02834e26bbd851eedb888bafba666bc0af72770c`](https://www.okx.com/web3/explorer/xlayer/address/0x02834e26bbd851eedb888bafba666bc0af72770c) — Sourcify exact match
- **Mainnet evidence (LIVE, 2026-09-20)**: first real Guard fill, 5 USDG → 0.01498 AAPLx under `REFERENCE_CONTEXT`, tx [`0x333a…5449`](https://www.okx.com/web3/explorer/xlayer/tx/0x333a6e41742f046d478e6a074f80d148d678e5baf8ab7f0c0736041c20245449) — `GuardedExecution(spent=5000000, received=14983578260014962, refunded=0)`; Guard keeps 0 USDG and 1 wei of rebasing dust; details in `deployments.json`.
- PlanGuard contract (X Layer 196, v2 — one-signature mandates, step-by-step certificates, permissionless executor): address in `deployments.json` once deployed; fork-verified 2026-09-21 (two buys + one sell through a third-party executor).
- Code: this repository. Everything here was written during the Dev Day build window; contract addresses, transaction hashes and Sourcify match ids are in `docs/deployments.json`.

## The problem

Agents buying tokenized US stocks on-chain make three silent mistakes: they trust a **symbol** instead of a chain + contract; they compare an on-chain quote against a stock "price" that is actually a **stale close** or has no source time; and they treat an **unknown price impact as zero**. Existing tooling (RWA dashboards, wallet simulation, generic copilots) shows numbers — it does not tell you when the numbers are *not comparable*.

## What an agent can buy

| Product | What it delivers | "No good answer" is still delivery |
|---|---|---|
| `verify_once` | One immutable report on one fixed intent | A `rejected` report with reason codes |
| `plan` | Up to 12 concrete candidates (amount × funding token × policy) with completion %, fees, blocking reasons and one explicit next step | "Nothing is feasible under your limits, here is which limit binds" |
| `monitor_window` | The goal is kept alive; every evaluation says *what changed, what it affects, what is next* | "Still waiting, and why" |
| `task_bundle` | A signed mandate executed step by step inside the user's limits, plus the evidence bundle | Partial completion with the unspent budget untouched |

## What Chaconne Verify does

1. **StockProof (sold through OKX AI).** Input a fixed intent (owner, stablecoin, stock token, exact-in amount, policy, limits). The service collects evidence — OKX DEX quote + route calldata, on-chain token metadata (with block), OKX RWA registry entry, Finnhub reference tick/close with *source* time — and runs a deterministic rule engine. Output: an immutable report `eligible | limited | rejected` with reason codes, every evidence record's `requestedAt / receivedAt / sourcePublishedAt`, and a keccak `evidenceHash`. Three explicit policies, never auto-downgraded:
   - `STRICT_LIVE` — regular US hours + live reference (≤90 s old) + fresh quote. Outside regular hours the correct answer is **rejected**.
   - `REFERENCE_CONTEXT` — official close (or two-source cross-verified close) as context; not called "live".
   - `QUOTE_ONLY` — route/quote/impact checks only; comparison explicitly `not_requested`.
2. **RWA Guard (X Layer).** A re-verification issues a 60-second EIP-712 `VerificationCertificate` bound to the user's EIP-712 `TradeIntent` (amount, minOut, recipient, router, spender, calldata hash, policy/registry/evidence hashes, nonce, deadline). The Guard contract checks both signatures, allowlists (policy, registry, route, selector, tokens), pulls the exact input, grants a single-use exact allowance, calls the OKX DEX router, attributes only this-tx balance deltas, enforces the absolute minimum output, refunds unspent input to the owner and delivers output to the recipient. Anything else reverts; nonce is consumed only on success.
3. **Planner.** A goal (basket legs, budget across several accepted stablecoins, side, policy, limits, deadline) is turned into a deterministic ladder of candidates. Each candidate is scored under **all three policies**, so the user sees not only "no" but "no under STRICT_LIVE, yes under REFERENCE_CONTEXT at 50% of the budget". Shrinking the amount is never silently treated as completing the original goal. `USER_MUST_RELAX_LIMIT` is never auto-executed.
4. **Mandate + PlanGuard (X Layer, v2).** The user signs **one** EIP-712 `TradeMandate`: input token, allowed output set, total budget cap, per-step cap, max steps, policy/registry hashes, validity window, nonce. The service then re-verifies before every step and signs a short-lived `StepCertificate`; **any executor** may submit the step (the user's own agent wallet or browser wallet). The contract enforces order (`stepIndex == steps`), caps, allowlists, calldata hash, and pays out only to the recipient — an executor can never take the funds. The service holds no key that can move money and runs no relayer.
5. **Portable evidence.** `GET /v1/{jobs,mandates}/:id/bundle` returns everything needed to re-check the work: registry, policy, every evidence record with its four timestamps, reports, plans, certificates and signatures, executions, and the bill. `bundleHash` is signed by the attestation key. A **pure client-side verifier page** and a CLI re-run the hashes, the signatures and the rules, and a built-in tamper box shows exactly which layer fails when a field is edited.
6. **Same task record throughout.** Payment (x402), report versions, mandates, steps and executions are separate states referencing one task; a rejected report is a delivered service, and paying never grants trade permission.

## Architecture

```
Agent / OKX AI / MCP host / browser
        │  POST /a2mcp/verify (A2MCP)  |  /v1/* (API key)  |  verify-web proxy
        ▼
apps/verify-service  (Express 5 + OKX x402 SDK)
  ├─ evidence/live.ts   OKX DEX quote+swap (ladder, buy & sell), OKX RWA list, X Layer RPC, Finnhub, xStocks multiplier
  ├─ core/verify        rule engine + planner + delta + bundle (pure), hashes, EIP-712, policies, registry
  ├─ plans/ mandates/   planner use-cases · mandate registry · monitor worker · step certificates
  ├─ payments/          orders · payment attempts · entitlements · reconcile · refund tickets
  ├─ execution/         Guard/PlanGuard ABI · on-chain receipt verifier (SUBMITTED → REORG_PENDING → CONFIRMED / REVERTED / UNKNOWN)
  └─ attestation/       one key, signs VerificationCertificate / StepCertificate / bundleHash only
        ▼
packages/verify-contracts  ChaconneVerifyGuard (single trade) · ChaconneVerifyPlanGuard (mandates)  →  OKX DEX Router
        ▲
packages/verify-mcp (agent tools, optional user-side agent wallet) · packages/verify-sdk · apps/verify-web (incl. offline bundle verifier)
```

Frozen interfaces: `docs/interfaces.md`. Address provenance: `docs/the address-approval log (internal)`. Deployments and versions: `docs/deployments.json`.

## Reproduce locally (no keys needed)

```bash
pnpm install
pnpm -w test                      # core 203 · service 43 · mcp 6 · contracts 53 (forge)
# service in FIXTURE mode (no external calls), free, with a web key.
# ATTESTATION_PRIVATE_KEY below is anvil's well-known public test account #0 — never use it for anything real:
cd packages/db && DATABASE_URL=pglite://../../.pgdata-verify pnpm db:migrate && cd ../..
cd apps/verify-service && DATABASE_URL=pglite://../../.pgdata-verify NODE_ENV=test PAYMENT_MODE=mock \
  EVIDENCE_MODE=fixture REGISTRY_MODE=fixture GUARD_ADDRESS=0x4444444444444444444444444444444444444444 \
  ATTESTATION_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  VERIFY_API_KEYS="dev:web:*" pnpm start
curl -s -X POST http://127.0.0.1:8790/a2mcp/verify -H 'content-type: application/json' -d '{}' | head -c 400   # → 400 input_required + schema
```

LIVE mode needs OKX Onchain OS credentials and a Finnhub key (`apps/verify-service/.env.example`). The X Layer fork execution (`pnpm --filter @chaconne/verify-service fork:execute`) needs `anvil` and OKX credentials; it deploys the Guard on a local fork, fetches real OKX route calldata, signs both structures and executes — evidence in `changes.md`.

## Evidence modes (every screen and record is labelled)

`LIVE` real upstream call · `REPLAY` recorded real response · `FIXTURE` constructed input · `FORK` local mainnet fork · `SIMULATION` pre-execution estimate. Test results per case: `test-results.md`.

## What is new vs. pre-existing (rules: only build-window work is judged)

Pre-existing Chaconne (July 2026): Solana/Jupiter trading site, Pyth/Finnhub reference pipeline, premium engine, quality gates, data APIs. **New in the build window**: everything listed in `changes.md` — the verification rule engine and evidence model, the paid service with x402 and A2MCP, the Guard contract and its tests, the OKX X Layer adapters and registry, the MCP server, the standalone web entry, and this documentation. No pre-existing code was relabelled as new.

## Honest limits

- Pyth's equity feeds lost entitlement on 2026-08-26; the reference source is **Finnhub** (source time = last trade). Documented as CV-D02.
- OKX's RWA list on X Layer currently returns an empty `stockPrice`, so the "two-source close" path is implemented but not exercised live.
- First version: one issuer (xStocks), `exactIn` only, EOA wallets only (no EIP-1271), assets: USDG/USDC/USD₮0 ↔ AAPLx/NVDAx (SPYx stays disabled for lack of a second source). **Selling goes through the mandate path (PlanGuard v2), not the single-job path**: the stock tokens are share-accounted, so every transfer delivers ~1 wei less than requested; PlanGuard tolerates that (`inputShortfallTolerance`, and the unused remainder is refunded in the same transaction), while the v1 Guard has no tolerance and a single-job sell reverts `InputTransferShortfall`. First mainnet sell: `deployments.json → mainnetEvidence3`.
- The planner ranks **only** the candidates it priced (ladder amounts × accepted funding tokens). It does not claim to search the whole market, and OKX rate-limits concurrent quotes, so a plan is at most 8 quotes per leg.
- A close taken from the 16:00 ET last trade is labelled `close_last_tick` and carries an explicit "not yet confirmed" note until the next day's previous-close agrees with it. Finnhub's daily candle endpoint is not available on the free tier, so that confirmation path exists but is off by default.
- xStocks corporate-action history needs an API key we do not have; the before/after unit-change page is a clearly labelled constructed REPLAY built from real multiplier observations.
- A mandate reduces signing to once, but it is still a standing permission: the user can pause it off-chain and revoke it on-chain, and every step is capped and re-verified. That is the trade-off, stated plainly.
- Paid A2MCP is implemented and tested against the OKX SDK contract (server SDK with a mock facilitator, and the official client SDK end-to-end); the listing is submitted **free** first. The real X Layer testnet facilitator has been exercised LIVE (verify / settle / status); both settlement transactions reverted because the payer wallet held no test USD₮0, which surfaced that the facilitator's verify does not check balance — so settlement now defaults to synchronous (`SETTLE_SYNC=true`) and a report is never delivered on an unconfirmed payment. Two funded LIVE settlements on X Layer testnet then succeeded (`deployments.json` → `x402Evidence`).
- The service holds exactly one key: the attestation signer. It cannot move user funds. Admin can pause / rotate the signer / edit allowlists — a stated trust boundary, not "trustless".
- Rebasing output tokens (xStocks EVM) leave ≤ a few wei of rounding dust in the Guard (CV-D05); it belongs to no user and can only be swept by the owner.
- The receipt verifier marks CONFIRMED after 6 X Layer confirmations and re-checks a vanished receipt (REORG_PENDING → SUBMITTED); it is not a finality proof against the L1 settlement.

## Team

Solo builder (Chaconne operator).

## License

MIT — see `LICENSE`. Source integrity: `docs/RELEASE.json` carries the tree hash of this snapshot; recompute with `pnpm release:hash` and compare with the deployed service's `GET /healthz` → `release.treeHash`.
