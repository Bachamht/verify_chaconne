# @chaconne/verify-mcp

Thin MCP (stdio) wrapper over the Chaconne Verify HTTP service. By default it **holds no keys, never signs, never pays** — payment and signing stay in the user-controlled host / wallet. An optional **agent-wallet mode** (your own wallet, client side, hard spend cap) lets an agent such as your MCP client pay, sign a TradeMandate and execute PlanGuard steps without any operator click. The service side never holds a key that can move funds (D-081).

## Tools (v1)

| Tool | Backs onto | Notes |
|---|---|---|
| `list_supported_assets` | `GET /v1/assets` | chain + contract identity; evidence mode LIVE/FIXTURE |
| `get_verification_policy` | `GET /v1/policies` | STRICT_LIVE / REFERENCE_CONTEXT / QUOTE_ONLY, hashes, price, entitlement |
| `prepare_verification` | `POST /v1/jobs` | creates a fixed-intent task; no payment, no trade permission |
| `purchase_verification` | `GET /v1/jobs/:id/report` | unpaid → returns the x402 challenge (`paymentRequired`), host pays and calls again with `paymentSignature`; never charges twice |
| `get_verification` | `GET /v1/jobs/:id` (+report) | status only, never initiates payment |
| `prepare_guard_trade` | `POST /v1/jobs/:id/prepare-execution` | returns typed data for the owner to sign + service certificate + exact approval + Guard call params |
| `get_execution_status` | `GET /v1/jobs/:id` + RPC receipt | decodes `GuardedExecution`; submission ≠ fill |

## Tools (v2 — plans, mandates, evidence bundles, Club)

| Tool | Backs onto | Notes |
|---|---|---|
| `plan_trade` | `POST /v1/plans` | amount ladder × input assets × three policies → candidates with completion ratio, blocking reasons, next step; `recommended` only ever eligible |
| `create_simulation` | `POST /v1/simulations` | LIVE evidence, no certificate, no execution; output labelled SIMULATION |
| `get_products` | `GET /v1/products` | SKUs, prices, validity, what counts as delivered |
| `prepare_mandate` | (local) | builds the EIP-712 `TradeMandate` typed data (PlanGuard domain, `outputSetHash`, fresh nonce) for the owner to sign |
| `register_mandate` | `POST /v1/mandates` | submits typedData + signature; `signLocally=true` signs with the agent wallet when it is the owner |
| `get_mandate` / `pause_mandate` / `resume_mandate` / `cancel_mandate` | `/v1/mandates/:id[...]` | off-chain state; hard stop = `revokeMandate` on PlanGuard from the owner wallet |
| `execute_next_step` | `POST …/prepare-step` → PlanGuard `executeStep` → `POST …/steps/:n/submissions` | **agent-wallet only**; checks the step against the registered mandate and local limits before sending; `dryRun` available |
| `get_evidence_bundle` | `GET /v1/{jobs,mandates}/:id/bundle` | portable bundle with `bundleHash` + attestation signature |
| `verify_evidence_bundle` | (local) | offline: hashes, EIP-712 digests, signatures, rule re-run; `online=true` adds receipt/event comparison |
| `create_share_card` | `POST /v1/shares` | private by default; amounts exact / range / hidden; wallet always hidden |

### agent-wallet mode (CV-D08)

Set all three in the MCP server's own `.env` (never in the service):

```bash
AGENT_WALLET_PRIVATE_KEY=0x…      # your agent wallet (client side)
AGENT_WALLET_MAX_SPEND_USD=0.10   # hard cap for x402 payments in this process
AGENT_WALLET_CHAIN_IDS=196,1952   # chains executeStep may be sent to
```

Partial configuration refuses to start. Any other `*PRIVATE_KEY*` / `MNEMONIC` / `SEED_PHRASE` variable also refuses to start. The key is never logged; tool results only show the address. What the mode enables: `purchase_*` auto-pays x402 challenges (EIP-3009 authorization via the official OKX client SDK; settlement gas is paid by the facilitator) until the cap is reached, `register_mandate` can sign locally, `execute_next_step` sends transactions. Everything else behaves exactly as without the mode.

### `verify-bundle` CLI

```bash
node packages/verify-mcp/bin/verify-bundle.mjs bundle.json [--signer 0x<attestation signer>] [--rpc https://rpc.xlayer.tech]
```

Prints a JSON checklist (same checks as the `/verify-bundle` web page: `@chaconne/core/verify` `verifyBundleOffline` + viem signature verification; `--rpc` adds `GuardedExecution` / `MandateStep` receipt comparison) and exits 1 if any check fails. Works with the service switched off.

## Run

This package is **not published on npm** (`npx -y @chaconne/verify-mcp` does not work). It runs from the public repository; the bin entry executes the TypeScript source through `tsx`, so no build step is needed:

```bash
git clone https://github.com/Bachamht/verify_chaconne && cd verify_chaconne
pnpm install
VERIFY_SERVICE_URL=https://verify.chaconne.xyz node packages/verify-mcp/bin/chaconne-verify-mcp.mjs
```

`VERIFY_API_KEY` is required for everything beyond the read-only and free tools. Get one at **https://verify.chaconne.xyz/agent/keys**: connect your wallet, sign one message (no transaction), copy the key. The key is bound to that wallet, so tasks created on the site and through MCP are the same set, and you can revoke it there any time. Without a key, keyed tools answer `{ status: "not_available", reason: "missing_api_key" }` with the URL above.

Machine-readable entry points on the service: `GET /pub/openapi.json`, `GET /pub/llms.txt`, `GET /pub/agent-card.json` (also `/openapi.json`, `/llms.txt`, `/.well-known/agent-card.json` on the web domain).

### MCP client config (any stdio MCP client)

```json
{
  "mcpServers": {
    "chaconne-verify": {
      "command": "node",
      "args": ["<path to the clone>/packages/verify-mcp/bin/chaconne-verify-mcp.mjs"],
      "env": { "VERIFY_SERVICE_URL": "https://verify.chaconne.xyz", "VERIFY_CALLER": "0x<your wallet>" }
    }
  }
}
```

The process refuses to start if any `*PRIVATE_KEY*` / `MNEMONIC` variable is present in its environment.

## Tests

`pnpm --filter @chaconne/verify-mcp test` — official SDK `Client` over `InMemoryTransport` (initialize, capability negotiation, tool discovery, calls, 402 challenge, error mapping) and over a real `StdioClientTransport` (spawned process).

## Free tools (no key; A2MCP endpoints)

| Tool | Backs onto | Notes |
|---|---|---|
| `verify_once_free` | `POST /a2mcp/verify` | one-shot verification; symbols / 0x / eip155 keys, human `amount`; result carries `publicUrl` + `publicBundleUrl` for key-less re-checks |
| `plan_free` | `POST /a2mcp/plan` | candidates, never executes |
| `agent_tasks_free` | `POST /a2mcp/agent-tasks` | event impacts + `taskDrafts[].draft` = ready `POST /v1/tasks` body |

A2MCP transport: the service answers HTTP 200 for both `delivered` and `input_required` (missing parameters are described in the body, header `X-A2MCP-Status` mirrors it); paid tiers answer 402.

## v6 · Chaconne Agent 工具（interfaces §11.8 的 23 个 + CV-D16 批次 4 的 5 个；合计 51 个）

`get_market_context` · `get_events` · `create_task` · `get_task` · `pause_task` / `resume_task` / `cancel_task` · `authorize_task` · `get_my_event_impacts` · `watch_thesis` · `add_thesis_review_item` · `explain_task_wait` · `compare_task_policies` · `replay_policy` · `preview_rebalance` · `create_rebalance_plan` · `get_budget_group` · `create_budget_group` · `get_portfolio` · `report_cost_override` · `register_webhook` · `link_telegram` · `executor_heartbeat`。

- 端点尚未部署（HTTP 404 not_found / 501 / 503）时工具返回结构化 `{ status: "not_available", endpoint, httpStatus }`（`isError=false`），不用假数据、不用回放冒充实时。
- `pause_task` / `cancel_task` 的摘要复述 D-088：服务侧停止只阻止后续签发，已取走且未过期的证书仍可能可执行，彻底停止以链上 `revokeMandate` 确认为准。
- `authorize_task` 只在 agent-wallet 模式代签 TradeMandate：钱包必须是 owner、链在 `AGENT_WALLET_CHAIN_IDS` 内、`budgetCap`（按 `inputDecimals`，默认 6）折美元不超过 `AGENT_WALLET_MAX_SPEND_USD`；否则返回 `budget_exceeds_agent_limit`，不签名不上送。无 agent-wallet 时可传浏览器钱包产出的 `signature`。
- agent-wallet 模式下进程每 60 s 自动向 `POST /v1/mandates/:id/executor/heartbeat` 报在线（只针对本进程 `authorize_task` / `execute_next_step` 过的 mandate）；`executor_heartbeat` 可手动加入/移出。心跳不携带任何权限。
- **CV-D16 · 目标式任务**：`create_task` 不传 `playbookId` = 目标任务（`agent_goal`）：只给 `scope`（目标、资产集合、总额、每笔上限）+ 可选 `strategy` 文本与 `watchEvents`；没有模板与计划条件，何时买 / 买哪个 / 买多少由 agent 决定。agent 的循环：`report_agent_status accepted`（接管，带 `agent.name`）→ 被唤醒（`get_task` 的 `agentTurn`；关注事件临近 / 到点 / 改期都会叫）→ `get_market_context` / `get_events` / 自己的数据 → `submit_trade_intent` 或 `report_agent_status`（declined / needs_evidence / plan_revised（`plan.text` / `strategy`）/ ended）→ 真实任务用 `execute_trade_intent` 发交易。「到点」只是预定时间已到，实际值要 agent 自己核实。
- **CV-D16 · agent 自主决策（5 个）**：`submit_trade_intent`（意图 + 决策记录 → 四道核验 → 证书；422 = 被拒但记录保存）· `get_task_intents`（`withStep=true` 在证书有效期内再取 READY 体）· `withdraw_trade_intent` · `report_agent_status`（declined / needs_evidence / plan_revised / ended 都是正常结果）· `execute_trade_intent`（agent-wallet 模式：取意图的 READY 体 → 本地与链上核对 → 发送 executeStep）。签证书 ≠ 发交易。
- 日志只走 stderr；stdout 是 JSON-RPC 通道。
