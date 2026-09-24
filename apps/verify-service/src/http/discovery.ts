/**
 * 机器可读的发现文件（V-40）：Agent / 目录爬虫接入的第一步不该断在 404。
 *   GET /pub/openapi.json     OpenAPI 3.1：免 key 端点完整描述 + 需 key 端点的入口摘要（字段以 core contracts 为准）
 *   GET /pub/llms.txt         纯文本：服务是什么、免费端点、怎么调一次、MCP 在哪
 *   GET /pub/agent-card.json  agent card：名称 / 描述 / 端点 / 鉴权 / 联系方式
 * 只描述本部署真实挂载的路径；价格、登记表、链 id 来自运行时配置，不写死。
 */
import { EVENT_KINDS, PLAYBOOK_IDS, POLICIES, REASON_CODES, TASK_STATUSES, type AssetRegistry } from "@chaconne/core/verify";
import { CONDITION_TYPES } from "@chaconne/core/verify";
import type { VerifyConfig } from "../config";
import { A2MCP_INPUT_SCHEMA, A2MCP_PATH } from "./a2mcp";
import { A2MCP_AGENT_TASKS_INPUT_SCHEMA, A2MCP_AGENT_TASKS_PATH } from "./a2mcpAgentTasks";
import { A2MCP_MONITOR_PATH, A2MCP_PLAN_INPUT_SCHEMA, A2MCP_PLAN_PATH } from "./a2mcpPlan";

export const DISCOVERY_PATHS = { openapi: "/pub/openapi.json", llmsTxt: "/pub/llms.txt", agentCard: "/pub/agent-card.json" } as const;
export const SERVICE_VERSION = "0.1.0";
export const MCP_RUN_STEPS = [
  "git clone https://github.com/Bachamht/verify_chaconne && cd verify_chaconne",
  "pnpm install",
  "VERIFY_SERVICE_URL=<service base url> node packages/verify-mcp/bin/chaconne-verify-mcp.mjs   # free read-only tools need no VERIFY_API_KEY; keyed tools report not_available until VERIFY_API_KEY is set",
] as const;

export interface DiscoveryDeps {
  cfg: VerifyConfig;
  registry: AssetRegistry;
  /** 本部署实际挂载的可选能力（路由不挂的不写进文档） */
  mounted: { plans: boolean; mandates: boolean; club: boolean; market: boolean; context: boolean; events: boolean; tasks: boolean; theses: boolean; laneD: boolean; lab: boolean; recaps: boolean };
}

const base = (cfg: VerifyConfig) => (cfg.PUBLIC_BASE_URL || "https://verify.chaconne.xyz").replace(/\/$/, "");

const FREE_RATE_LIMIT_NOTE = "Free endpoints are rate-limited per client IP (RateLimit-Limit / RateLimit-Remaining / RateLimit-Reset headers; 429 + Retry-After when exceeded).";
const A2MCP_NOTE = "A2MCP transport rule: these endpoints answer HTTP 200 for both delivered results and missing/invalid input (body.status = delivered | input_required; header X-A2MCP-Status mirrors it) and 402 for paid tiers; they never return 4xx for input problems, because the OKX client treats any other status as endpoint_unreachable.";

function assetsSummary(reg: AssetRegistry) {
  const stables = reg.entries.filter((e) => e.role === "stable_input").map((e) => e.displaySymbol);
  const stocks = reg.entries.filter((e) => e.role === "stock_output" && e.executionAllowed).map((e) => `${e.displaySymbol} (${e.underlyingId.split(":")[1]})`);
  return { stables, stocks };
}

/* ---------- OpenAPI 3.1 ---------- */

const jsonResp = (description: string, schema: unknown = { type: "object" }) => ({ description, content: { "application/json": { schema } } });
const a2mcpEnvelope = {
  type: "object",
  description: "A2MCP envelope. status=delivered → ok:true and the result fields; status=input_required → ok:false with missingParams / problems / schema / example / howToCall so the caller can collect the parameters.",
  required: ["ok", "status"],
  properties: {
    ok: { type: "boolean" },
    status: { type: "string", enum: ["delivered", "input_required", "rate_limited"] },
    summary: { type: "string", description: "One-paragraph English summary (URLs are placed at the end of the sentence with no trailing punctuation)" },
    missingParams: { type: "array", items: { type: "string" } },
    problems: { type: "array", items: { type: "object", properties: { field: { type: "string" }, value: { type: "string" }, hint: { type: "string" } } } },
    schema: { type: "object" },
    example: {},
    howToCall: { type: "object" },
  },
};
const a2mcpResponses = { "200": jsonResp("Delivered result or input_required envelope (always 200)", a2mcpEnvelope), "402": { description: "Paid tier: x402 challenge in the PAYMENT-REQUIRED header" }, "429": { description: "Rate limited (RateLimit-* and Retry-After headers)" } };
const a2mcpOp = (summary: string, description: string, schema: unknown, tag: string) => ({
  post: { tags: [tag], summary, description: `${description}\n\n${A2MCP_NOTE}`, security: [], requestBody: { required: false, content: { "application/json": { schema } } }, responses: a2mcpResponses },
  get: { tags: [tag], summary: `${summary} (GET with query string; same body semantics)`, security: [], parameters: [{ name: "*", in: "query", description: "Same fields as the POST body, as query parameters", schema: { type: "string" } }], responses: a2mcpResponses },
});
const keyed = (summary: string, description: string, tag: string, method: "get" | "post", extra: Record<string, unknown> = {}) => ({
  [method]: { tags: [tag], summary, description, security: [{ apiKey: [] }], responses: { "200": jsonResp("OK"), "401": { description: "missing_api_key" }, "403": { description: "invalid_api_key / not the owner" }, "404": { description: "not found (or not visible to this caller)" } }, ...extra },
});
const idParam = (name: string) => ({ name, in: "path", required: true, schema: { type: "string" } });

export function buildOpenApi(d: DiscoveryDeps) {
  const url = base(d.cfg);
  const { stables, stocks } = assetsSummary(d.registry);
  const m = d.mounted;
  const paths: Record<string, unknown> = {
    "/healthz": { get: { tags: ["public"], summary: "Liveness + public capability flags", description: "Public view: ok, time, evidenceMode, registryVersion, paymentNetwork, release.treeHash (public integrity anchor), capability flags. Internal detail (context source URL, key ids, startedAt) is only in /healthz?deep=1 with an API key.", security: [], parameters: [{ name: "deep", in: "query", schema: { type: "string", enum: ["1"] }, description: "With a valid API key: the detailed object" }], responses: { "200": jsonResp("health") } } },
    "/v1/assets": { get: { tags: ["public"], summary: "Verified asset registry", description: `Chain + contract are the identity; symbols are display only. Current registry: stablecoins ${stables.join(" / ")}; stock tokens ${stocks.join(" / ")}.`, security: [], responses: { "200": jsonResp("registry") } } },
    "/v1/policies": { get: { tags: ["public"], summary: "Verification policies and hashes", description: `Policies: ${Object.keys(POLICIES).join(" / ")}. Includes policyDefinitionHash per version, pricing and the re-verification entitlement. No automatic downgrade between policies.`, security: [], responses: { "200": jsonResp("policies") } } },
    "/v1/products": { get: { tags: ["public"], summary: "Product catalog (SKUs, prices, what counts as delivered)", security: [], responses: { "200": jsonResp("products") } } },
    [DISCOVERY_PATHS.openapi]: { get: { tags: ["discovery"], summary: "This document", security: [], responses: { "200": jsonResp("OpenAPI 3.1") } } },
    [DISCOVERY_PATHS.llmsTxt]: { get: { tags: ["discovery"], summary: "Plain-text guide for LLM agents", security: [], responses: { "200": { description: "text/plain" } } } },
    [DISCOVERY_PATHS.agentCard]: { get: { tags: ["discovery"], summary: "Agent card (name, endpoints, auth, contact)", security: [], responses: { "200": jsonResp("agent card") } } },
  };
  if (m.tasks) paths["/v1/playbooks"] = { get: { tags: ["public"], summary: "Task playbooks (templates) with parameter specs", description: `Playbooks: ${PLAYBOOK_IDS.join(" / ")}. Condition types: ${CONDITION_TYPES.join(" / ")}.`, security: [], responses: { "200": jsonResp("playbooks") } } };
  if (m.context) {
    paths["/v1/context"] = { get: { tags: ["public"], summary: "Signed market context (free agent tier)", description: "Always 200; unavailable fields are status=unavailable and never omitted or replaced by 0. Without a key only tier=agent is served. Filters: assetKey, owner, taskId (the last two need a key).", security: [], parameters: [{ name: "tier", in: "query", schema: { type: "string", enum: ["agent", "paid", "internal", "display"] } }, { name: "assetKey", in: "query", schema: { type: "string" } }, { name: "owner", in: "query", schema: { type: "string" } }, { name: "taskId", in: "query", schema: { type: "string" } }], responses: { "200": jsonResp("MarketContext (fields carry value/source/observedAt/fetchedAt/status)") } } };
  }
  if (m.events) {
    paths["/v1/events"] = { get: { tags: ["public"], summary: "Market events (earnings, macro, Fed, holidays)", description: `Kinds: ${EVENT_KINDS.join(" / ")}. Stable ids, datePrecision exact|day|estimate, revision numbers. Windows are computed by each task from its own conditions, never by the producer.`, security: [], parameters: [{ name: "from", in: "query", schema: { type: "string", format: "date" } }, { name: "to", in: "query", schema: { type: "string", format: "date" } }, { name: "underlyingId", in: "query", schema: { type: "string" } }, { name: "kind", in: "query", schema: { type: "string", enum: [...EVENT_KINDS] } }], responses: { "200": jsonResp("{ events: MarketEvent[] }") } } };
    paths["/v1/events/{id}/revisions"] = { get: { tags: ["public"], summary: "Revision history of one event", security: [], parameters: [idParam("id")], responses: { "200": jsonResp("{ eventId, revisions }"), "404": { description: "event_not_found" } } } };
  }
  paths[A2MCP_PATH] = a2mcpOp("Verify once (StockProof)", `One-shot verification of a tokenized-stock purchase on X Layer: policy check, reference vs executable price, price impact, market session. Free tier delivers the report inline and auto-publishes a key-less public report (publicUrl, publicBundleUrl). Identical (owner, asset, amount, policy) within 60 s reuses the same job. Input is forgiving: symbols (${stocks.map((s) => s.split(" ")[0]).join(" / ")}), 0x addresses or eip155 keys; human amounts ("100"); common aliases.`, A2MCP_INPUT_SCHEMA, "a2mcp");
  if (m.plans && m.mandates) {
    paths[A2MCP_PLAN_PATH] = a2mcpOp("Plan a trade (candidates, no execution)", "Amount ladder × funding asset × three policies → evidence-checked candidates with completion ratio, blocking reasons and next step. Never executes.", A2MCP_PLAN_INPUT_SCHEMA, "a2mcp");
    paths[A2MCP_MONITOR_PATH] = a2mcpOp("Register a signed TradeMandate for monitoring", "Same body as POST /v1/mandates. Returns the mandate view and a statusUrl; the id is unguessable.", { type: "object", description: "Signed TradeMandate registration (see POST /v1/mandates)" }, "a2mcp");
    paths[`${A2MCP_MONITOR_PATH}/{id}`] = { get: { tags: ["a2mcp"], summary: "Mandate status (unguessable id, no key)", security: [], parameters: [idParam("id")], responses: { "200": jsonResp("mandate view"), "404": { description: "mandate_not_found" } } } };
  }
  paths[A2MCP_AGENT_TASKS_PATH] = a2mcpOp("Agent Tasks: event impacts + ready-to-submit task drafts", "Give an owner wallet and/or a set of stock tokens. Returns event impacts (against holdings and tasks) and task drafts; each taskDrafts[].draft is a complete SIMULATION body for POST /v1/tasks (a dated replay suggestion, when no event is in range, is in taskDrafts[].replay, not in the body). Nothing is executed.", A2MCP_AGENT_TASKS_INPUT_SCHEMA, "a2mcp");
  if (m.club) {
    paths["/pub/reports"] = { get: { tags: ["public"], summary: "Public board of voluntarily shared reports", security: [], responses: { "200": jsonResp("{ items }") } } };
    paths["/pub/reports/{shareId}"] = { get: { tags: ["public"], summary: "One public report (wallet hidden, amounts per privacy setting)", security: [], parameters: [idParam("shareId")], responses: { "200": jsonResp("public report"), "404": { description: "share_not_found (private or unknown)" } } } };
    paths["/pub/reports/{shareId}/bundle"] = { get: { tags: ["public"], summary: "Evidence bundle of a public job/mandate report (bundleHash + attestation signature; verify offline with @chaconne/core verifyBundleOffline or the verify-bundle CLI)", security: [], parameters: [idParam("shareId")], responses: { "200": jsonResp("EvidenceBundle"), "402": { description: "paid report not settled" }, "404": { description: "share_not_found / bundle_not_available" } } } };
    paths["/pub/live"] = { get: { tags: ["public"], summary: "Same as /pub/reports", security: [], responses: { "200": jsonResp("{ items }") } } };
  }
  if (m.recaps) paths["/pub/recaps/{shareId}"] = { get: { tags: ["public"], summary: "Public nightly recap (owner-published)", security: [], parameters: [idParam("shareId")], responses: { "200": jsonResp("recap"), "404": { description: "share_not_found" } } } };
  paths["/pub/market/xlayer"] = { get: { tags: ["public"], summary: "Public market snapshot for X Layer stock tokens", description: m.market ? "Served from cached OKX DEX quotes (TTL 60 s)." : "Not configured on this deployment → 503 unavailable.", security: [], responses: { "200": jsonResp("snapshot"), "503": { description: "unavailable" } } } };
  /* 需 key 的入口摘要（详细字段以 contracts.ts / interfaces.md §11 为准） */
  paths["/v1/jobs"] = keyed("Create a verification job (fixed intent; no payment, no trade permission)", "Idempotent per clientRequestId. Body: ownerAddress, recipientAddress?, executionChainId, inputAssetKey, outputAssetKey, amountInRaw, mode=exactIn, policyId, policyVersion, maxSlippageBps, maxPriceImpactBps?, maxReferenceDeviationBps?", "keyed", "post", { responses: { "201": jsonResp("job view") } });
  paths["/v1/jobs/{id}"] = keyed("Job status", "Owner-scoped.", "keyed", "get", { parameters: [idParam("id")] });
  paths["/v1/jobs/{id}/report"] = keyed("Report (x402 paywall when priced)", "402 with PAYMENT-REQUIRED until paid; free tier returns the report directly.", "keyed", "get", { parameters: [idParam("id")] });
  paths["/v1/jobs/{id}/bundle"] = keyed("Evidence bundle (owner)", "Same bundle as /pub/reports/{shareId}/bundle once the report is shared publicly.", "keyed", "get", { parameters: [idParam("id")] });
  if (m.tasks) {
    paths["/v1/tasks"] = keyed("Create a task from a playbook", `Body: clientRequestId, ownerAddress, playbookId (${PLAYBOOK_IDS.join(" | ")}), mode (SIMULATION | LIVE), params { inputAssetKey, outputAssetKey, steps, perStepAmountRaw, ... }, conditions? { version: "conditions/1", items }, thesis?. Returns the task with ALL blockers (codes: ${REASON_CODES.slice(0, 8).join(", ")}, …), nextCheckAt, executorPresence, a TradeMandate draft (LIVE) and the thesis card. Task statuses: ${TASK_STATUSES.join(" / ")}.`, "keyed", "post", { responses: { "201": jsonResp("task view"), "400": { description: "invalid_request / invalid_playbook_params (English message + messageZh)" } } });
    paths["/v1/tasks/{id}"] = keyed("Task view (blockers, nextCheckAt, executor presence, mandates, thesis)", "Owner-scoped.", "keyed", "get", { parameters: [idParam("id")] });
    for (const a of ["pause", "resume", "cancel", "authorize", "prepare-step"]) paths[`/v1/tasks/{id}/${a}`] = keyed(`${a} task`, a === "prepare-step" ? "200 READY (certificate) or 409 WAIT with all blockers." : a === "authorize" ? "Submit the signed TradeMandate for a LIVE task." : "Service-side stop semantics: only blocks new certificates; on-chain revokeMandate is the hard stop.", "keyed", "post", { parameters: [idParam("id")] });
  }
  if (m.lab) {
    paths["/v1/tasks/{id}/explain-wait"] = keyed("Explain why a task waits (GET only; other methods → 405 + Allow)", "All blockers with evidence time, nextCheckAt and userActionRequired.", "keyed", "get", { parameters: [idParam("id"), { name: "locale", in: "query", schema: { type: "string", enum: ["en", "zh"] } }] });
    paths["/v1/tasks/{id}/compare-policies"] = keyed("Compare two condition sets on the same evidence snapshot (SIMULATION)", "Body: { variants: [{ label, conditions }, { label, conditions }] }.", "keyed", "post", { parameters: [idParam("id")], responses: { "201": jsonResp("comparison") } });
    paths["/v1/replays"] = keyed("Decision replay without look-ahead", "Body: { playbookId, conditions, assetKey, from, to }. Gaps are reported as gaps; no returns are computed.", "keyed", "post", { responses: { "201": jsonResp("replay") } });
  }
  if (m.theses) paths["/v1/theses/{id}"] = keyed("Thesis card (machine / timing / research premises)", "timing premises (session, step gap, event windows) are shown but never invalidate the thesis.", "keyed", "get", { parameters: [idParam("id")] });
  if (m.laneD) paths["/v1/event-impacts"] = keyed("Event impacts for an owner (events × holdings × tasks)", "Query: owner, horizonHours (default 48). Same implementation backs /a2mcp/agent-tasks.eventImpacts.", "keyed", "get");

  return {
    openapi: "3.1.0",
    info: {
      title: "Chaconne Verify / Chaconne Agent",
      version: SERVICE_VERSION,
      summary: "Evidence-backed verification and conditional execution for tokenized US stocks on X Layer.",
      description: `Verification of data comparability and execution constraints for tokenized-stock trades (xStocks on X Layer, chain ${d.registry.chainId}). Every result is a signed, hash-anchored report with re-checkable evidence. Not investment advice; no prediction of price direction; nothing is ever executed without the owner's own wallet signature.\n\n${FREE_RATE_LIMIT_NOTE}\n\n${A2MCP_NOTE}\n\nEvidence mode on this deployment: ${d.cfg.EVIDENCE_MODE.toUpperCase()}. Report price USD: ${d.cfg.REPORT_PRICE_USD}. Payment network: ${d.cfg.PAYMENT_NETWORK}.`,
      contact: { name: "Chaconne", url: url },
      license: { name: "MIT", url: "https://github.com/Bachamht/verify_chaconne" },
    },
    servers: [{ url }],
    tags: [
      { name: "discovery", description: "Machine-readable entry points (no key)" },
      { name: "public", description: "Free read-only endpoints (no key; per-IP rate limit)" },
      { name: "a2mcp", description: "OKX AI A2MCP single-endpoint services (no key; 200-only transport; 402 for paid tiers)" },
      { name: "keyed", description: "Owner-scoped endpoints (x-api-key or Authorization: Bearer). Keys are issued by the operator; wallet-scoped keys also need x-verify-caller: <0x address>." },
    ],
    components: {
      securitySchemes: { apiKey: { type: "apiKey", in: "header", name: "x-api-key", description: "Operator-issued API key (Authorization: Bearer <key> also accepted). Wildcard keys (web:*) additionally require x-verify-caller: <EVM address>." } },
      headers: {
        "RateLimit-Limit": { schema: { type: "integer" }, description: "Requests allowed per window on free endpoints" },
        "RateLimit-Remaining": { schema: { type: "integer" } },
        "RateLimit-Reset": { schema: { type: "integer" }, description: "Seconds until the window resets" },
        "X-A2MCP-Status": { schema: { type: "string", enum: ["delivered", "input_required", "rate_limited"] }, description: "Mirrors body.status on /a2mcp/* responses (body stays the source of truth)" },
      },
      schemas: { A2mcpEnvelope: a2mcpEnvelope, A2mcpVerifyInput: A2MCP_INPUT_SCHEMA, A2mcpPlanInput: A2MCP_PLAN_INPUT_SCHEMA, A2mcpAgentTasksInput: A2MCP_AGENT_TASKS_INPUT_SCHEMA },
    },
    paths,
    "x-mcp": { package: "@chaconne/verify-mcp (workspace package, not on npm)", run: MCP_RUN_STEPS, freeTools: ["get_market_context", "list_supported_assets", "get_verification_policy", "get_events", "verify_once_free", "plan_free", "agent_tasks_free"] },
  };
}

/* ---------- llms.txt ---------- */

export function buildLlmsTxt(d: DiscoveryDeps): string {
  const url = base(d.cfg);
  const { stables, stocks } = assetsSummary(d.registry);
  const m = d.mounted;
  const lines = [
    "# Chaconne Verify / Chaconne Agent",
    "",
    "> Evidence-backed verification and conditional execution for tokenized US stocks (xStocks) on X Layer. Every result is a signed, hash-anchored report whose evidence can be re-checked without an account. Not investment advice; nothing predicts price direction; nothing executes without the owner's own wallet signature.",
    "",
    `Base URL: ${url}`,
    `Evidence mode on this deployment: ${d.cfg.EVIDENCE_MODE.toUpperCase()} · report price USD ${d.cfg.REPORT_PRICE_USD} · payment network ${d.cfg.PAYMENT_NETWORK} · chain ${d.registry.chainId}`,
    `Assets: stablecoins ${stables.join(" / ")}; stock tokens ${stocks.join(" / ")} (symbols, 0x addresses and eip155 keys are all accepted on A2MCP endpoints)`,
    "",
    "## Free endpoints (no API key; per-IP rate limit with RateLimit-* headers)",
    "",
    `- GET ${url}/healthz — liveness, evidence mode, registry version, release.treeHash, capability flags`,
    `- GET ${url}/v1/assets — verified asset registry (chain + contract are the identity)`,
    `- GET ${url}/v1/policies — STRICT_LIVE / REFERENCE_CONTEXT / QUOTE_ONLY definitions and hashes`,
    `- GET ${url}/v1/products — SKUs, prices, what counts as delivered`,
    ...(m.tasks ? [`- GET ${url}/v1/playbooks — task templates (${PLAYBOOK_IDS.join(", ")}) and their parameters`] : []),
    ...(m.context ? [`- GET ${url}/v1/context?tier=agent — signed market context; always 200, unavailable fields are marked, never zeroed`] : []),
    ...(m.events ? [`- GET ${url}/v1/events?from=YYYY-MM-DD&to=YYYY-MM-DD — earnings / macro / Fed / holiday events with revisions`] : []),
    `- POST ${url}${A2MCP_PATH} — verify one purchase (A2MCP; see below)`,
    ...(m.plans && m.mandates ? [`- POST ${url}${A2MCP_PLAN_PATH} — plan candidates (A2MCP)`, `- POST ${url}${A2MCP_MONITOR_PATH} — register a signed TradeMandate for monitoring (A2MCP)`] : []),
    `- POST ${url}${A2MCP_AGENT_TASKS_PATH} — event impacts + ready-to-submit task drafts (A2MCP)`,
    ...(m.club ? [`- GET ${url}/pub/reports/{shareId} and ${url}/pub/reports/{shareId}/bundle — public report and its evidence bundle (bundleHash + attestation signature)`] : []),
    `- GET ${url}${DISCOVERY_PATHS.openapi} — OpenAPI 3.1 · GET ${url}${DISCOVERY_PATHS.agentCard} — agent card`,
    "",
    "## Call it once",
    "",
    "```",
    `curl -X POST ${url}${A2MCP_PATH} -H 'Content-Type: application/json' \\`,
    `  -d '{"ownerAddress":"0x1111111111111111111111111111111111111111","outputAssetKey":"${stocks[0]?.split(" ")[0] ?? "AAPLx"}","amount":"100"}'`,
    "```",
    "",
    "A2MCP transport rule: the response is HTTP 200 both when delivered (body.status = delivered) and when input is missing or invalid (body.status = input_required, with missingParams / problems / schema / example / howToCall). The X-A2MCP-Status header mirrors body.status. Paid tiers answer 402 with an x402 challenge. A delivered verification includes publicUrl (key-less public report) and publicBundleUrl (evidence bundle); the same (owner, asset, amount, policy) within 60 s reuses the same job.",
    "",
    "## Keyed endpoints",
    "",
    "Owner-scoped endpoints under /v1/jobs, /v1/tasks, /v1/theses, /v1/event-impacts, /v1/portfolio, /v1/notify need x-api-key (or Authorization: Bearer). Keys are issued by the operator; wallet-scoped keys also send x-verify-caller: <0x address>. Error bodies are { error, message (English), messageZh?, details? }. Wrong HTTP method on a known path answers 405 with an Allow header.",
    "",
    "## MCP server",
    "",
    "The MCP server (@chaconne/verify-mcp) is a workspace package in the public repository, not on npm:",
    "",
    "```",
    ...MCP_RUN_STEPS,
    "```",
    "",
    "Without VERIFY_API_KEY it starts with the free read-only tool set (get_market_context, list_supported_assets, get_verification_policy, get_events, verify_once_free, plan_free, agent_tasks_free); keyed tools answer { status: \"not_available\", reason: \"api_key_required\" } instead of failing. The server holds no keys, never signs and never pays unless you opt into its agent-wallet mode with your own wallet.",
    "",
    "## Rules that never bend",
    "",
    "- Unknown is never shown as zero; unavailable data stays unavailable.",
    "- No policy is downgraded automatically; a rejected verdict is a delivered result.",
    "- Service-side pause/cancel only stops new certificates; the hard stop is on-chain revokeMandate.",
    "- Evidence bundles are verifiable offline with @chaconne/core verifyBundleOffline or the verify-bundle CLI in the repository.",
    "",
  ];
  return lines.join("\n");
}

/* ---------- agent card ---------- */

export function buildAgentCard(d: DiscoveryDeps) {
  const url = base(d.cfg);
  const { stables, stocks } = assetsSummary(d.registry);
  const m = d.mounted;
  const skill = (id: string, name: string, description: string, method: "GET" | "POST", path: string, auth: "none" | "apiKey") => ({ id, name, description, method, url: `${url}${path}`, auth });
  const skills = [
    skill("verify_once", "Verify once (StockProof)", "Verify a tokenized-stock purchase against a policy: reference vs executable price, price impact, session. Delivers a signed report plus a key-less public report URL and evidence bundle.", "POST", A2MCP_PATH, "none"),
    ...(m.plans && m.mandates ? [skill("plan", "Plan a trade", "Amount ladder × funding asset × three policies → evidence-checked candidates; never executes.", "POST", A2MCP_PLAN_PATH, "none"), skill("monitor", "Monitor a signed mandate", "Register a signed TradeMandate and follow its steps; hard stop is on-chain revokeMandate.", "POST", A2MCP_MONITOR_PATH, "none")] : []),
    skill("agent_tasks", "Agent Tasks", "Event impacts for an owner's holdings/tasks and ready-to-submit SIMULATION task drafts (each draft is a POST /v1/tasks body).", "POST", A2MCP_AGENT_TASKS_PATH, "none"),
    ...(m.context ? [skill("market_context", "Market context", "Signed market context (session, events, blackout, drift); unavailable fields are marked, never zeroed.", "GET", "/v1/context", "none")] : []),
    ...(m.events ? [skill("events", "Market events", "Earnings / macro / Fed / holiday events with stable ids and revisions.", "GET", "/v1/events", "none")] : []),
    skill("assets", "Asset registry", "Verified asset registry (chain + contract identity).", "GET", "/v1/assets", "none"),
    skill("policies", "Verification policies", "Policy definitions and hashes.", "GET", "/v1/policies", "none"),
    ...(m.tasks ? [skill("create_task", "Create a task", "Playbook-based conditional task (SIMULATION or LIVE with the owner's TradeMandate).", "POST", "/v1/tasks", "apiKey")] : []),
    ...(m.club ? [skill("public_report", "Public report + bundle", "Key-less re-check of a shared verification: report and evidence bundle.", "GET", "/pub/reports/{shareId}", "none")] : []),
  ];
  return {
    schemaVersion: "chaconne-agent-card/1",
    name: "Chaconne Verify / Chaconne Agent",
    description: "Evidence-backed verification and conditional execution for tokenized US stocks (xStocks) on X Layer. Signed, hash-anchored reports with re-checkable evidence; no investment advice; nothing executes without the owner's own wallet signature.",
    url,
    version: SERVICE_VERSION,
    provider: { organization: "Chaconne", url },
    documentationUrl: `${url}${DISCOVERY_PATHS.llmsTxt}`,
    openapiUrl: `${url}${DISCOVERY_PATHS.openapi}`,
    capabilities: { streaming: false, pushNotifications: m.recaps || m.tasks, stateTransitionHistory: m.tasks, a2mcp: true, x402: d.cfg.paid || d.cfg.PRODUCT_PRICE_PLAN_USD !== "0" || d.cfg.PRODUCT_PRICE_MONITOR_WINDOW_USD !== "0" },
    authentication: { schemes: ["none", "apiKey"], apiKey: { in: "header", name: "x-api-key", alternative: "Authorization: Bearer <key>", note: "Free endpoints and all /a2mcp/* endpoints need no key. Keys are issued by the operator; wallet-scoped keys also send x-verify-caller." }, rateLimit: FREE_RATE_LIMIT_NOTE },
    transport: { a2mcp: A2MCP_NOTE, errors: "Error bodies: { error, message (English), messageZh?, details? }; wrong method on a known path → 405 + Allow." },
    defaultInputModes: ["application/json"],
    defaultOutputModes: ["application/json"],
    skills,
    deployment: { evidenceMode: d.cfg.EVIDENCE_MODE.toUpperCase(), chainId: d.registry.chainId, registryVersion: d.registry.version, paymentNetwork: d.cfg.PAYMENT_NETWORK, reportPriceUsd: d.cfg.REPORT_PRICE_USD, stablecoins: stables, stockTokens: stocks },
    mcp: { package: "@chaconne/verify-mcp", distribution: "workspace package in the public repository (not on npm)", run: MCP_RUN_STEPS, freeTools: ["get_market_context", "list_supported_assets", "get_verification_policy", "get_events", "verify_once_free", "plan_free", "agent_tasks_free"] },
    contact: { url, repository: "https://github.com/Bachamht/verify_chaconne" },
  };
}
