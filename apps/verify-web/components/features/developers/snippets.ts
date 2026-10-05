/** 开发者页代码块（逐字迁自 v7 开发者页；SERVICE 由构建期变量决定） */
import { SERVICE } from "./devNav";

export const SNIPPET_FREE = `# no API key needed
curl "${SERVICE}/v1/assets"        # registry: assetKey, symbol, decimals, role, executionAllowed
curl "${SERVICE}/v1/policies"      # the three policies with definition hashes
curl "${SERVICE}/v1/context?tier=agent&assetKey=eip155:196:0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a"
# → 200 { "schemaVersion":"chaconne-context/1", "packagedAt":"…", "provenance":{"mode":"live"},
#         "session":{"label":{"value":"US_REGULAR","status":"ok","source":"…","observedAt":"…"}, …},
#         "events":[…], "fed":{…}, "rates":{"y10":{"value":"4.96","status":"ok"}, …},
#         "risk":{"vix":{"value":null,"status":"unavailable","note":"not_in_tier"}, …} }`;

export const SNIPPET_A2MCP = `curl -X POST ${SERVICE}/a2mcp/verify -H "Content-Type: application/json" -d '{
  "ownerAddress": "0xYourWallet",
  "outputAssetKey": "AAPLx",      # or AAPL / NVDAx / NVDA / a 0x address
  "amount": "100",                # 100 USDG (human units); or amountInRaw
  "policyId": "REFERENCE_CONTEXT" # optional; STRICT_LIVE | REFERENCE_CONTEXT | QUOTE_ONLY
}'

# → 200 {"ok":true,"status":"delivered","summary":"ELIGIBLE under REFERENCE_CONTEXT: …","verdict":"eligible","jobId":"job_…","report":{…}}
# → 200 {"ok":false,"status":"input_required","missingParams":[…],"schema":{…},"example":{…}}   (never 4xx)
# → 402 + PAYMENT-REQUIRED header                                                       (paid phase)`;

export const SNIPPET_V1 = `# x-api-key: issue one at /agent/keys (wallet signature); the key is bound to that wallet
curl -X POST ${SERVICE}/v1/jobs -H "x-api-key: <your key>" -H "Content-Type: application/json" -d '{
  "clientRequestId": "my-1", "ownerAddress": "0xYourWallet",
  "inputAssetKey": "eip155:196:0x4ae46a509f6b1d9056937ba4500cb143933d2dc8", "outputAssetKey": "eip155:196:0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a",
  "amountInRaw": "5000000", "policyId": "REFERENCE_CONTEXT", "maxSlippageBps": 50, "maxPriceImpactBps": 100, "maxReferenceDeviationBps": 300 }'`;

export const SNIPPET_V6 = `# create a simulation task: inputAssetKey + perStepAmountRaw are required by the playbook
curl -X POST ${SERVICE}/v1/tasks -H "x-api-key: <your key>" -H "Content-Type: application/json" -d '{
  "clientRequestId": "my-task-1", "ownerAddress": "0xYourWallet", "playbookId": "session_dca", "mode": "SIMULATION",
  "params": { "inputAssetKey": "eip155:196:0x4ae46a509f6b1d9056937ba4500cb143933d2dc8", "outputAssetKey": "eip155:196:0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a", "steps": 3, "perStepAmountRaw": "1000000" },
  "conditions": { "version": "conditions/1", "items": [ { "type": "session", "allow": ["US_REGULAR"] }, { "type": "min_gap_trading_days", "days": 1 } ] } }'
# → 201 { "task": { "id": "tsk_…", "status": "WAITING", "blockers": [...], "nextCheckAt": "…" }, "mode": "SIMULATION", ... }
# 400 invalid_playbook_params → details[] = [{ "field": "perStepAmountRaw", "code": "required" }, ...]
# GET  /v1/tasks/:id/explain-wait   (GET only; a POST is not the same resource)`;

export const SNIPPET_MCP_CALLS = `// example tool calls (arguments are plain JSON)
get_market_context      { "tier": "agent", "assetKey": "AAPLx" }
get_my_event_impacts    { "owner": "0xYourWallet", "horizonHours": 48 }
create_task             { "ownerAddress": "0xYourWallet", "playbookId": "session_dca", "mode": "SIMULATION",
                          "params": { "inputAssetKey": "USDG", "outputAssetKey": "AAPLx", "steps": 3, "perStepAmountRaw": "1000000" },
                          "conditions": { "version": "conditions/1", "items": [ { "type": "session", "allow": ["US_REGULAR"] } ] } }
explain_task_wait       { "taskId": "tsk_…" }`;

export const SNIPPET_MCP_INSTALL = `# the package is not published on npm yet — run it from the repo:
git clone https://github.com/Bachamht/verify_chaconne && cd verify_chaconne && pnpm install && node packages/verify-mcp/bin/chaconne-verify-mcp.mjs

{ "mcpServers": { "chaconne-verify": {
    "command": "node", "args": ["<path-to>/verify_chaconne/packages/verify-mcp/bin/chaconne-verify-mcp.mjs"],
    "env": { "VERIFY_SERVICE_URL": "${SERVICE}", "VERIFY_API_KEY": "<key from /agent/keys>" }   // full tool set
    // "env": { "VERIFY_SERVICE_URL": "${SERVICE}" }                                              // read-only + free tools only
} } }`;

export const SNIPPET_SDK = `import { createClient } from "@chaconne/verify-sdk";
const c = createClient({ baseUrl: "${SERVICE}", apiKey: process.env.VERIFY_API_KEY /*, x402Signer: account */ });

const job  = await c.jobs.create({ ownerAddress, inputAssetKey, outputAssetKey, amountInRaw: "5000000", policyId: "REFERENCE_CONTEXT", maxSlippageBps: 50, maxPriceImpactBps: 100, maxReferenceDeviationBps: 300, clientRequestId: "my-1" });
const rep  = await c.jobs.report(job.body.jobId);          // pays via x402 automatically when x402Signer is set
const plan = await c.plans.create({ /* PlanGoal + clientRequestId */ });
const m    = await c.mandates.create({ /* typedData + signature + legs … */ });
const step = await c.mandates.prepareStep(m.body.mandateId); // → executeStep on PlanGuard from your wallet
const bundle = await c.jobs.bundle(job.body.jobId);         // re-check offline with verify_evidence_bundle / npx verify-bundle`;

export const SDK_METHODS = "assets · policies · products · healthz · jobs.{create,get,report,bundle,bill} · plans.{create,get,toJob} · mandates.{create,get,pause,resume,cancel,prepareStep,submitStep,bundle,bill} · simulations · profiles · templates · shares.{create,getPublic} · a2mcp.{verify,plan,agentTasks} · v6";
export const SDK_METHODS_V6 = "context.get · events.{list,revisions,impacts} · tasks.{create,get,list,pause,resume,cancel,authorize,prepareStep,explainWait,comparePolicies} · executor.heartbeat · theses · budgetGroups · portfolio · notify · replays · rebalance · recaps.{list,get,share,getPublic} · missions.list · isNotAvailable()";
