# Chaconne Verify

**English** | [中文](README.zh-CN.md)

**OKX Dev Day 2026 · Build a Company track · built on top of the existing Chaconne project**

Chaconne Verify is a verification and guarded execution service for AI agents that trade tokenized US stocks on X Layer. Your agent makes the decisions with its own strategy. Chaconne checks every trade against evidence, keeps execution inside the scope the owner signed, and leaves a decision record that anyone can check again, offline, in a browser.

The live site calls itself **Chaconne Agent**, because that is what a user does there: hand a goal to an AI agent. The project, the OKX AI listing and the code keep the name **Chaconne Verify**. They are the same product, on the same domain, with the same contracts.

## Links

| What | Where |
|---|---|
| Live product | https://verify.chaconne.xyz/ |
| OKX AI listing | ASP #13803 "Chaconne Verify": https://www.okx.ai/agents/13803 |
| A2MCP services on that listing | StockProof Trade Verification `POST https://verify.chaconne.xyz/a2mcp/verify` and Agent Task Drafts `POST https://verify.chaconne.xyz/a2mcp/agent-tasks` (both free) |
| Guard contract (X Layer mainnet, chain 196) | [`0x02834e26bbd851eedb888bafba666bc0af72770c`](https://www.okx.com/web3/explorer/xlayer/address/0x02834e26bbd851eedb888bafba666bc0af72770c), Sourcify exact match |
| PlanGuard contract (X Layer mainnet, chain 196) | [`0xE8517f296211F4b9175796bAAB47979FB14Fd2F0`](https://www.okx.com/web3/explorer/xlayer/address/0xE8517f296211F4b9175796bAAB47979FB14Fd2F0), Sourcify exact match |
| Developer docs | https://verify.chaconne.xyz/developers, plus machine readable `/openapi.json`, `/llms.txt` and `/.well-known/agent-card.json` |
| Deployments, hashes and evidence | `docs/deployments.json` |
| Work done in the build window | `docs/changes.md` |

Mainnet evidence on X Layer:

* First buy through Guard, 5 USDG for 0.01498 AAPLx: [`0x333a…5449`](https://www.okx.com/web3/explorer/xlayer/tx/0x333a6e41742f046d478e6a074f80d148d678e5baf8ab7f0c0736041c20245449)
* First sell through PlanGuard, AAPLx back to USDG: [`0xee9d…2180`](https://www.okx.com/web3/explorer/xlayer/tx/0xee9dce5e931974c2b9ef8cc593ad9871e1da906010bf9415651bc8cfb7e22180)
* x402 settlements for paid verification on the X Layer testnet (chain 1952): see `x402Evidence` in `docs/deployments.json`

## The problem

Agents that buy tokenized US stocks on chain tend to make three quiet mistakes. They trust a ticker instead of a chain and a contract address. They compare an on chain quote with a stock "price" that is really a stale close, or has no source time at all. They treat an unknown price impact as zero. And once an agent holds a wallet key, the owner has no way to say "only these stocks, only this much, only until Friday" and have that rule enforced.

Chaconne Verify fixes both halves. The agent keeps its own judgement. The platform checks the facts, and a contract enforces the limits.

## How it works

The product has three layers, and the website is organised the same way.

### 1. The task: a goal, a strategy, and a scope you sign

A task is a goal written in plain words (for example "over the next five trading days, split my budget between AAPLx and NVDAx according to how the market digests each macro release"), a strategy the agent should follow, and a scope.

* **The goal and the strategy sit outside the signature.** The owner can edit them at any time, every edit is kept as a new version, and no new signature is needed. The agent reads the latest version on its next round.
* **The scope is what the owner signs, once, as an EIP 712 `TradeMandate`.** It lists the stocks the agent may buy, the total budget, the cap per trade, the maximum number of trades, the deadline, whether selling is allowed, the trust tier for the agent's evidence, and optional hard constraints such as "US regular hours only". The scope cannot be widened afterwards. A wider scope means a new task and a new signature.

### 2. The context: what the agent reasons with

* **Event calendar.** CPI, payrolls, FOMC, Fed speeches, other macro releases, earnings for every supported stock, US holidays and early closes, each with a stable id and an honest precision (exact time, day only, or estimated).
* **Market context.** Session label, Fed blackout, rates, VIX, and the cross asset reaction after the last major release (relief, transmission or divergence). Context comes from our Crowsnest pipeline, is signed with Ed25519, and every field carries its own status, so a missing value is reported as unavailable rather than guessed.
* **Wake ups.** When an event the task watches is approaching, is due, or is rescheduled, the platform opens a new round for the agent. The agent has thirty minutes to respond. A round with no answer is recorded and nothing happens.

### 3. Verification: what the platform guarantees

In each round the agent can submit a trade intent, hold and ask for more evidence, revise its plan, or end the task. Holding is a complete decision, not a failure.

A trade intent is "what to buy and how much" together with a decision record: the reason, and the sources it relied on. Before anything can execute, the platform runs four checks:

1. **Evidence sorting.** Each source is classified as a fact the platform verified, data the agent brought, or the agent's own research. The owner's trust tier decides which kinds are admissible. Anything the platform did not verify is labelled "provided by the agent, unverified".
2. **Scope and hard constraints.** The stock must be in the signed set, the amount must fit the per trade cap and the remaining budget, the trade count and the deadline must still allow it, and every hard constraint must hold on the fresh quote.
3. **Execution checks.** The same engine as the single trade verification: token identity against a curated registry, reference price and its age, the OKX DEX quote and route, and the price impact.
4. **Certificate binding.** The step certificate must bind to the exact mandate the owner signed.

Only when all four pass does a live task receive a step certificate. The certificate is valid for sixty seconds at most, and usually about thirty. The agent's wallet or the owner's browser wallet then sends the step to PlanGuard, which checks the certificate, the mandate signature, the caps, the allowlists and the calldata hash, pays out only to the recipient, and refunds unused input in the same transaction. A rejected intent is still stored with its reasons.

### The decision record

Every task keeps a timeline of wake ups, decisions, intents, the four check results, certificates and fills. The owner can export it as JSON from the task page and paste it into `/verify-bundle`. The page recomputes every hash, every EIP 712 digest and every signature locally in the browser, and re runs the rules. Change a single number and the check fails. The same verifier is available as a CLI in `packages/verify-mcp`.

## Try it in five minutes

You need a browser wallet (OKX Wallet works). Simulations never move funds.

1. Open https://verify.chaconne.xyz/ and click **Try a task for free**. Connect your wallet and sign the sign in message. Signing in costs no gas and grants nothing; it only proves the address is yours.
2. Pick one of the five sample tasks, for example the macro driven allocation across two stocks, and click **Create a simulation and play the agent**.
3. You are now the agent for one round. Try all three decisions: hold and ask for evidence, revise the plan, then submit a buy intent. The timeline records each one, and the intent shows the four checks.
4. Open the task page. You will find the signed scope, the strategy with its versions, a box to add requirements without signing again, and the decision timeline.
5. Expand **Execution details**, click **Export the decision bundle (JSON)**, copy it, click **Verify offline**, paste it and run the checks. Then change one number and run them again.

To call the service the way other agents do, open the OKX AI listing, click **Use now**, and give the prompt it shows to any agent that has Onchain OS installed.

## For agents and developers

* **OKX AI (A2MCP).** Two free services on ASP #13803. Missing or invalid input always returns HTTP 200 with `status: "input_required"`, the missing fields, a schema and an example; success returns `status: "delivered"`. The paid tier answers HTTP 402 with an x402 challenge.
* **MCP.** `packages/verify-mcp` exposes 51 tools, from `get_market_context`, `get_events` and `create_task` to `submit_trade_intent`, `report_agent_status`, `execute_trade_intent` and `verify_evidence_bundle`. An agent wallet mode can execute certified steps within limits set in its own environment.
* **SDK and HTTP.** `packages/verify-sdk` and the REST API described in `/openapi.json`.
* **API keys.** Market context, the asset registry, the policies and the A2MCP endpoints need no key. Everything that acts for a wallet needs a key, and a user issues one at `/agent/keys` with a single wallet signature. The key is bound to that wallet and can be revoked there.

## Security model and trust boundary

* The service holds exactly one key, the attestation signer. It signs certificates and bundle hashes. It cannot move user funds.
* Funds move only through Guard or PlanGuard, only within the signed mandate, and only to the recipient in that mandate.
* PlanGuard constrains trades that go through it. An agent that holds a full private key could still send other transactions from that wallet directly; the product never claims otherwise.
* The contract owner can pause, rotate the signer and edit allowlists. That is a stated trust boundary, not a "trustless" claim.
* The website acts only for the wallet that signed in, and every write through the API needs a key bound to the wallet it acts for.

## Repository layout

| Path | Contents |
|---|---|
| `apps/verify-service` | The service: evidence collection, rule engine wiring, planner, tasks, intents, mandates, x402 payments, receipt verifier, A2MCP endpoints |
| `apps/verify-web` | The website, including the offline decision record verifier |
| `packages/core/src/verify` | Pure logic: rules, policies, registry, hashing, EIP 712, planner, task scope, intents, bundle verification |
| `packages/verify-contracts` | `ChaconneVerifyGuard` (single trade) and `ChaconneVerifyPlanGuard` (mandates), with Foundry tests |
| `packages/verify-mcp` | MCP server, agent wallet executor and bundle verifier CLI |
| `packages/verify-sdk` | TypeScript client |
| `packages/db` | The `verify_*` tables and SQL migrations |
| `docs` | Interfaces, deployments, change list, test results, demo script |

## Reproduce locally

No keys are needed for the fixture mode below.

```bash
pnpm install
pnpm typecheck
pnpm test                                             # unit and integration suites
(cd packages/verify-contracts && forge build && forge test)
pnpm --filter @chaconne/verify-web build
```

Run the service in fixture mode, with no external calls. The attestation key below is Anvil's well known public test account #0. Never use it for anything real.

```bash
cd packages/db && DATABASE_URL=pglite://../../.pgdata-verify pnpm db:migrate && cd ../..
cd apps/verify-service && DATABASE_URL=pglite://../../.pgdata-verify NODE_ENV=test PAYMENT_MODE=mock \
  EVIDENCE_MODE=fixture REGISTRY_MODE=fixture GUARD_ADDRESS=0x4444444444444444444444444444444444444444 \
  ATTESTATION_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 \
  VERIFY_API_KEYS="dev:web:*" pnpm start
# in another terminal
curl -s -X POST http://127.0.0.1:8790/a2mcp/verify -H 'content-type: application/json' -d '{}' | head -c 400
```

The last command returns `status: "input_required"` with the schema and an example. Live mode needs OKX Onchain OS credentials and a Finnhub key, listed in `apps/verify-service/.env.example`. Per case test results are in `docs/test-results.md`.

## Check that this code is what runs in production

`docs/RELEASE.json` carries a tree hash of every file in this snapshot. Run `pnpm release:hash` after cloning and compare the result with `release.treeHash` from https://verify.chaconne.xyz/healthz. Both contracts can be rebuilt from `packages/verify-contracts` and compared on Sourcify.

## Evidence modes

Every screen and every record says where its data came from: `LIVE` is a real upstream call, `REPLAY` is a recorded real response, `FIXTURE` is constructed input, `FORK` is a local mainnet fork, and `SIMULATION` is an estimate before execution.

## What is new in the build window

Chaconne existed before the event as a Solana and Jupiter trading site with a reference price pipeline and a premium engine. Everything in this repository was written during the build window: the verification engine and evidence model, tasks with signed scopes, trade intents and the four checks, agent wake ups, the event calendar and context integration, the A2MCP services and x402 payments, both contracts and their tests, the X Layer registry and OKX adapters, the MCP server, the SDK, and the website. `docs/changes.md` lists it item by item.

## Known limits

* Stock reference prices come from Finnhub, because Pyth's equity feeds lost entitlement on 2026-08-26. The source time is the last trade, and a close taken from the 16:00 ET last trade stays labelled "not yet confirmed" until the next day agrees with it.
* One issuer (xStocks), about forty stocks, exact input swaps only, and externally owned wallets only.
* Selling goes through PlanGuard. The stock tokens are share accounted, so every transfer delivers about one wei less than requested. PlanGuard tolerates that and refunds the remainder; the single trade Guard does not, so a sell there would revert.
* Both A2MCP services are listed free. Paid A2MCP with x402 is implemented and has settled for real on the X Layer testnet, but it is not switched on for the listing.
* The planner ranks only the candidates it actually priced, and OKX rate limits concurrent quotes, so it never claims to have searched the whole market.
* A mandate turns many signatures into one, but it is still a standing permission. The owner can pause it in the service and revoke it on chain, and every step stays capped and verified again.
* The receipt verifier marks a transaction confirmed after six X Layer confirmations. That is not a proof of finality on the settlement layer.

## Team

Solo builder, the Chaconne operator.

## License

MIT, see `LICENSE`.
