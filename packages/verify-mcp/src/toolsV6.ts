/**
 * v6 工具（Chaconne Agent，interfaces §11.8）：上下文 / 事件 / 任务 / 授权 / 影响 / 理由卡 / 决策实验 / 调仓 / 资金组 / 组合 / 通知 / 心跳。
 * 纪律：
 *  - 端点未部署（404 not_found / 501 / 503）→ 结构化 `not_available`（isError=false），不伪装；
 *  - 只有 authorize_task 会签名，且只在 agent-wallet 模式、钱包 = owner、budgetCap 折美元 ≤ AGENT_WALLET_MAX_SPEND_USD 时；
 *  - 停止类工具的摘要必须复述 D-088：服务侧停止只阻止后续签发，已取走且未过期的证书仍可能可执行，彻底停止以链上撤销确认为准；
 *  - stdout 是协议通道，任何日志只走 stderr。
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Hex } from "viem";
import { EIP712_TYPES_V2 } from "@chaconne/core/verify";
import { executePreparedStep } from "./toolsV2";
import type { VerifyClient, HttpResult } from "./client";
import type { ExecutorHeartbeat } from "./heartbeat";
import { ADDR, ASSET_KEY, UINT, fail, fromHttp, ok, type ToolResult } from "./toolUtil";
import type { AgentWallet } from "./wallet";

export const TOOL_NAMES_V6 = [
  "get_market_context",
  "get_events",
  "create_task",
  "get_task",
  "pause_task",
  "resume_task",
  "cancel_task",
  "authorize_task",
  "get_my_event_impacts",
  "watch_thesis",
  "add_thesis_review_item",
  "explain_task_wait",
  "compare_task_policies",
  "replay_policy",
  "preview_rebalance",
  "create_rebalance_plan",
  "get_budget_group",
  "create_budget_group",
  "get_portfolio",
  "report_cost_override",
  "register_webhook",
  "link_telegram",
  "executor_heartbeat",
  /* CV-D16 批次 4：agent 自主决策 */
  "submit_trade_intent",
  "get_task_intents",
  "withdraw_trade_intent",
  "report_agent_status",
  "execute_trade_intent",
] as const;

export interface V6Deps {
  client: VerifyClient;
  wallet: AgentWallet | null;
  heartbeat: ExecutorHeartbeat | null;
}

export const D088_NOTE = "Service-side stop only blocks NEW step certificates. A certificate already pulled and not yet expired may still be executed. A hard stop is the on-chain PlanGuard.revokeMandate confirmation (task REVOKE_PENDING → REVOKED); do not treat this response as a revocation.";

/** 端点未部署 → not_available（不是错误，也不是数据） */
export function notAvailable(endpoint: string, r: HttpResult): ToolResult {
  return {
    content: [{ type: "text", text: `not_available: ${endpoint} is not provided by this verify-service deployment yet (HTTP ${r.status}). Nothing was assumed or simulated in its place.` }],
    structuredContent: { status: "not_available", endpoint, httpStatus: r.status, body: r.body ?? null },
    isError: false,
  };
}
export function isNotAvailable(r: HttpResult): boolean {
  if (r.status === 501 || r.status === 503) return true;
  if (r.status !== 404) return false;
  const err = (r.body as { error?: string } | null)?.error;
  return err === undefined || err === "not_found" || err === "not_allowed";
}
function v6(endpoint: string, r: HttpResult, summary: (b: Record<string, unknown>) => string): ToolResult {
  return isNotAvailable(r) ? notAvailable(endpoint, r) : fromHttp(r, summary);
}
async function call(c: VerifyClient, endpoint: string, method: "GET" | "POST" | "PUT", path: string, body: unknown, summary: (b: Record<string, unknown>) => string): Promise<ToolResult> {
  try {
    return v6(endpoint, await c.call(method, path, body), summary);
  } catch (e) {
    return fail("service_unreachable", `${endpoint}: ${e instanceof Error ? e.message.slice(0, 200) : String(e)}`);
  }
}
const qs = (q: Record<string, string | number | undefined>) => {
  const p = Object.entries(q).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  return p.length ? `?${p.join("&")}` : "";
};
const taskOf = (b: Record<string, unknown>) => (b["task"] ?? b) as Record<string, unknown>;
const taskSummary = (b: Record<string, unknown>) => {
  const t = taskOf(b);
  const blockers = (t["blockers"] as Array<{ code: string }> | undefined) ?? [];
  return `task ${String(t["id"])} ${String(t["status"])}${blockers.length ? `; blockers: ${blockers.map((x) => x.code).join(", ")}` : ""}; nextCheckAt ${String(t["nextCheckAt"] ?? "unknown")}; executor ${String(t["executorPresence"] ?? "?")}`;
};

const CONDITION = z.object({ type: z.string() }).passthrough().describe("Condition item (core contracts §1.3): session | avoid_event_window | earnings_window | not_in_fed_blackout | max_vix | max_move | premium_bps_lte | min_gap_trading_days | max_steps_per_trading_day | require_cross_asset_confirmation | target_price_gte | target_price_lte | tracked_cost_pnl_pct_gte | cash_floor | thesis_holds");
/** CV-D16 授权范围（全部可缺省：缺省 = 计划本身） */
const SCOPE = z.object({
  objective: z.string().min(1).max(500).optional().describe("plain-language objective for the agent"),
  outputAssetKeys: z.array(ASSET_KEY).min(1).max(8).optional().describe("assets the agent may buy; must include params.outputAssetKey"),
  budgetCapRaw: UINT.optional().describe("total budget (raw); >= plan total"),
  perStepCapRaw: UINT.optional().describe("per-step cap (raw); >= plan per-step, <= budgetCapRaw"),
  maxSteps: z.number().int().min(1).max(1000).optional(),
  deadline: z.string().optional().describe("ISO; >= plan deadline"),
  allowSell: z.boolean().optional(),
  trustTier: z.enum(["platform_only", "agent_data", "agent_research"]).optional(),
  issuance: z.enum(["auto", "agent"]).optional().describe("auto = platform issues by plan conditions; agent = only on agent-submitted trade intents"),
  hardConditions: z.array(CONDITION).max(8).optional().describe("signed hard constraints (condition DSL); plan conditions cannot override them"),
});
const CONDITIONS = z.object({ version: z.literal("conditions/1").default("conditions/1"), items: z.array(CONDITION).min(1) });
const TYPED = z.object({ domain: z.record(z.string(), z.unknown()), types: z.record(z.string(), z.unknown()), primaryType: z.string(), message: z.record(z.string(), z.unknown()) });
const PLAYBOOK = z.enum(["session_dca", "event_aware_accumulate", "discount_watch", "target_sell", "portfolio_rebalance"]);
const EVENT_KIND = z.enum(["MACRO_TIER1", "MACRO_TIER2", "FED_SPEECH", "FED_BLACKOUT", "EARNINGS", "CORPORATE_ACTION", "MARKET_HOLIDAY", "EARLY_CLOSE"]);

function usdOfRaw(raw: string, decimals: number): string {
  const v = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const frac = (v % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${v / base}.${frac}` : `${v / base}`;
}
function usdLte(a: string, b: string): boolean {
  const scale = (s: string) => {
    const [w, f = ""] = s.split(".");
    return BigInt(w!) * 1_000_000n + BigInt((f + "000000").slice(0, 6));
  };
  return scale(a) <= scale(b);
}

export function registerV6Tools(server: McpServer, d: V6Deps): void {
  const c = d.client;

  server.registerTool(
    "get_market_context",
    { title: "Get market context (crowsnest, signed)", description: "GET /v1/context. Session label, US trading day / holiday / early close, upcoming macro & Fed events, Fed blackout, curve shape, drift verdict. Every field carries value/source/observedAt/fetchedAt/status; fields outside your tier are status=unavailable (note=not_in_tier), never omitted. Always HTTP 200; a missing sentinel shows as unavailable, never as 0. Filter by assetKey / owner / taskId to get only relevant events.", inputSchema: { tier: z.enum(["agent", "paid", "display"]).default("agent"), assetKey: ASSET_KEY.optional(), owner: ADDR.optional(), taskId: z.string().optional() } },
    async (a) => call(c, "GET /v1/context", "GET", `/v1/context${qs(a)}`, undefined, (b) => { const s = (b["session"] as { label?: { value?: string; status?: string } } | undefined)?.label; return `context packaged ${String(b["packagedAt"])}: session ${String(s?.value ?? "?")} (${String(s?.status ?? "?")}), ${((b["events"] as unknown[] | undefined) ?? []).length} event(s)`; }),
  );

  server.registerTool(
    "get_events",
    { title: "List market events", description: "GET /v1/events. Earnings, tier-1/2 macro, Fed speeches/blackout, holidays and early closes with stable ids, date precision (exact/day/estimate), status (confirmed/estimated/revised/cancelled/released) and revision number. Windows are NOT decided by the producer: each task computes its own from its conditions.", inputSchema: { from: z.string().optional().describe("ISO date/time"), to: z.string().optional(), underlyingId: z.string().optional().describe("e.g. us-stock:AAPL"), kind: EVENT_KIND.optional() } },
    async (a) => call(c, "GET /v1/events", "GET", `/v1/events${qs(a)}`, undefined, (b) => `${((b["events"] as unknown[] | undefined) ?? (Array.isArray(b) ? (b as unknown[]) : [])).length} event(s)`),
  );

  server.registerTool(
    "create_task",
    {
      title: "Create a task: a goal task (agent's own strategy) or a fixed-automation playbook",
      description: "POST /v1/tasks. GOAL TASK (omit playbookId): hand the agent an objective, an optional strategy text and a signed scope; no template, no plan conditions — the agent decides when / which asset / how much and submits trade intents (submit_trade_intent); it is woken on watched events (report via report_agent_status). TEMPLATE TASK (playbookId): fixed automation (session_dca / event_aware_accumulate / discount_watch / target_sell / portfolio_rebalance) with machine-checkable conditions the platform issues by itself. Returns the task (ALL blockers, nextCheckAt, executorPresence), a TradeMandate draft to sign (mode=LIVE), a thesis draft and the budget-group allocation result. mode=SIMULATION is usable immediately and never signs or executes anything. Conditions with premium_bps_lte on official_close / close_last_tick are refused for LIVE (simulation only). `scope` (CV-D16) is what the owner signs: allowed assets, total budget, per-step cap, steps, deadline, allowSell, trustTier, issuance and hard constraints; it defaults to the plan itself and must contain the plan. Plan conditions can change later without a new signature; the scope cannot. PlanGuard enforces the scope only for steps that go through the contract.",
      inputSchema: { clientRequestId: z.string().min(1).max(128), ownerAddress: ADDR, playbookId: PLAYBOOK.optional().describe("omit for a GOAL TASK (agent_goal): no template, no plan conditions — params are synthesized from `scope`; you decide when, which asset and how much and submit trade intents"), params: z.record(z.string(), z.unknown()).optional().describe("playbook parameters (template tasks), e.g. { steps, perStepAmountRaw, inputAssetKey, outputAssetKey }; for goal tasks only policyId / maxPriceImpactBps / maxSlippageBps pass through"), conditions: CONDITIONS.optional(), mode: z.enum(["SIMULATION", "LIVE"]).default("SIMULATION"), thesis: z.record(z.string(), z.unknown()).optional(), budgetGroupId: z.string().optional(), scope: SCOPE.optional().describe("REQUIRED for a goal task: objective, outputAssetKeys, budgetCapRaw, perStepCapRaw (+ optional maxSteps, deadline, trustTier default agent_data, hardConditions)"), strategy: z.string().max(4000).optional().describe("the strategy text the agent applies (outside the signature; versioned)"), watchEvents: z.object({ kinds: z.array(EVENT_KIND).max(8) }).optional().describe("event kinds that wake the agent (default MACRO_TIER1, EARNINGS, FED_SPEECH for agent-issued tasks)"), exampleId: z.string().max(64).optional() },
    },
    async (a) => call(c, "POST /v1/tasks", "POST", "/v1/tasks", a, (b) => `${taskSummary(b)}${b["mandateDraft"] ? "; mandateDraft ready to sign (authorize_task)" : ""}`),
  );

  server.registerTool(
    "get_task",
    { title: "Get task (or list an owner's tasks)", description: "GET /v1/tasks/:id (or GET /v1/tasks?owner when only `owner` is given). Full blockers list (not just the first), nextCheckAt, executorPresence (online = heartbeat within 3 min; awaiting_signature = browser-wallet path; offline), mandates and accounting. Owner-scoped: another wallet's task is 403/404.", inputSchema: { taskId: z.string().optional(), owner: ADDR.optional() } },
    async (a) => {
      if (!a.taskId && !a.owner) return fail("input_required", "give taskId or owner");
      return a.taskId ? call(c, "GET /v1/tasks/:id", "GET", `/v1/tasks/${a.taskId}`, undefined, taskSummary) : call(c, "GET /v1/tasks?owner", "GET", `/v1/tasks${qs({ owner: a.owner })}`, undefined, (b) => `${((b["tasks"] as unknown[] | undefined) ?? []).length} task(s)`);
    },
  );

  for (const action of ["pause", "resume", "cancel"] as const) {
    server.registerTool(
      `${action}_task`,
      { title: `${action[0]!.toUpperCase()}${action.slice(1)} task (service-side)`, description: `POST /v1/tasks/:id/${action}. ${action === "resume" ? "Resumes certificate issuance." : "Service-side stop semantics (D-088): " + D088_NOTE}`, inputSchema: { taskId: z.string().min(1) } },
      async (a) => call(c, `POST /v1/tasks/:id/${action}`, "POST", `/v1/tasks/${a.taskId}/${action}`, {}, (b) => `${taskSummary(b)}${action === "resume" ? "" : ` — ${String(b["note"] ?? D088_NOTE)}`}`),
    );
  }

  server.registerTool(
    "authorize_task",
    {
      title: "Authorize a task (sign TradeMandate — agent-wallet mode only)",
      description: "Signs the task's TradeMandate draft with the agent wallet and POSTs it to /v1/tasks/:id/authorize. Refuses unless agent-wallet mode is on, the agent wallet IS the mandate owner, and budgetCap (converted with inputDecimals, default 6) is within AGENT_WALLET_MAX_SPEND_USD — the same ceiling that caps x402 spending. The signing path is the one prepare_mandate/register_mandate use. Without agent-wallet mode pass the owner's `signature` from a browser wallet instead. Registers the mandate for automatic executor heartbeats.",
      inputSchema: { taskId: z.string().min(1), typedData: TYPED.optional().describe("defaults to the task's mandateDraft.typedData"), outputSet: z.array(ADDR).optional(), signature: z.string().regex(/^0x[0-9a-fA-F]+$/).optional().describe("owner-provided signature (browser wallet); skips local signing"), inputDecimals: z.number().int().min(0).max(18).default(6) },
    },
    async (a) => {
      let typedData = a.typedData;
      let outputSet = a.outputSet;
      if (!typedData) {
        const t = await c.call<Record<string, unknown>>("GET", `/v1/tasks/${a.taskId}`);
        if (isNotAvailable(t)) return notAvailable("GET /v1/tasks/:id", t);
        if (t.status !== 200) return fromHttp(t, () => "");
        const draft = (t.body["mandateDraft"] ?? (t.body["task"] as Record<string, unknown> | undefined)?.["mandateDraft"]) as { typedData?: z.infer<typeof TYPED>; outputSet?: string[] } | null | undefined;
        if (!draft?.typedData) return fail("no_mandate_draft", "task has no TradeMandate draft (SIMULATION task, or already authorized); create it with mode=LIVE");
        typedData = draft.typedData;
        outputSet = outputSet ?? draft.outputSet;
      }
      const owner = String(typedData.message["owner"] ?? "").toLowerCase();
      let signature = a.signature as Hex | undefined;
      if (!signature) {
        if (!d.wallet) return fail("agent_wallet_disabled", "authorize_task signs only in agent-wallet mode (AGENT_WALLET_PRIVATE_KEY + AGENT_WALLET_MAX_SPEND_USD + AGENT_WALLET_CHAIN_IDS in the MCP server's own .env). Otherwise pass `signature` from the owner's wallet.");
        if (owner !== d.wallet.address.toLowerCase()) return fail("owner_mismatch", `agent wallet ${d.wallet.address} is not the mandate owner ${owner}`);
        const chainId = Number((typedData.domain as { chainId?: number })["chainId"] ?? 0);
        if (chainId && !d.wallet.allowsChain(chainId)) return fail("chain_not_allowed", `chain ${chainId} not in AGENT_WALLET_CHAIN_IDS`);
        const cap = String(typedData.message["budgetCap"] ?? "");
        if (!/^\d+$/.test(cap)) return fail("bad_budget_cap", "mandate budgetCap missing");
        const capUsd = usdOfRaw(cap, a.inputDecimals);
        if (!usdLte(capUsd, d.wallet.cfg.maxSpendUsd)) return fail("budget_exceeds_agent_limit", `budgetCap ${capUsd} (inputDecimals ${a.inputDecimals}) exceeds AGENT_WALLET_MAX_SPEND_USD ${d.wallet.cfg.maxSpendUsd}; raise the limit in the MCP .env or lower the task budget`, { budgetCapUsd: capUsd, maxSpendUsd: d.wallet.cfg.maxSpendUsd });
        // 服务端草案若只给 domain/message（types 省略），按冻结的 PlanGuard v2 类型补齐后再签
        const types = typedData.types && Object.keys(typedData.types).length ? typedData.types : (EIP712_TYPES_V2 as unknown as Record<string, unknown>);
        try {
          signature = await d.wallet.signTypedData({ ...typedData, types, primaryType: "TradeMandate" });
        } catch (e) {
          return fail("sign_failed", e instanceof Error ? e.message.slice(0, 200) : String(e));
        }
      }
      const r = await c.call<Record<string, unknown>>("POST", `/v1/tasks/${a.taskId}/authorize`, { typedData, signature, outputSet, clientRequestId: `mcp-auth-${a.taskId}` });
      if (isNotAvailable(r)) return notAvailable("POST /v1/tasks/:id/authorize", r);
      if (r.status >= 200 && r.status < 300) {
        const mandateId = String(r.body["mandateId"] ?? (r.body["mandate"] as { mandateId?: string } | undefined)?.mandateId ?? "");
        if (mandateId && d.heartbeat) d.heartbeat.watch(mandateId);
        return ok(`${taskSummary(r.body)}; mandate ${mandateId || "?"} registered${d.heartbeat && mandateId ? "; executor heartbeat every 60 s" : ""}`, { status: r.status, ...r.body, signedBy: a.signature ? "owner" : "agent-wallet", heartbeatWatching: d.heartbeat?.watching ?? [] });
      }
      return fromHttp(r, () => "");
    },
  );

  server.registerTool(
    "get_my_event_impacts",
    { title: "My event impacts (C6)", description: "GET /v1/event-impacts?owner&horizonHours. Events × your holdings × your tasks → relation (company_direct / user_rule / macro_research), effect (wait / pause_issuance / recheck / none) and the allowed actions. Macro events are research links only — never a price prediction. Uncovered assets show as unknown, not as 'no impact'.", inputSchema: { owner: ADDR, horizonHours: z.number().int().min(1).max(336).default(48) } },
    async (a) => call(c, "GET /v1/event-impacts", "GET", `/v1/event-impacts${qs(a)}`, undefined, (b) => `${((b["impacts"] as unknown[] | undefined) ?? (Array.isArray(b) ? (b as unknown[]) : [])).length} impact(s) in ${a.horizonHours} h`),
  );

  server.registerTool(
    "watch_thesis",
    { title: "Watch a thesis (C7)", description: "POST /v1/theses. Attaches a thesis card to a task: machine premises are Conditions (three-state), research premises only collect review items (sourceUrl required) and stay unknown until the user marks them. onInvalidation: notify | pause_issuance (task PAUSED, issuance only) | draft_exit (sell/rebalance draft awaiting a NEW authorization). Nothing here can execute.", inputSchema: { taskId: z.string().min(1), goal: z.string().min(1), rationale: z.string().min(1), premises: z.array(z.object({ kind: z.enum(["machine", "research"]), text: z.string(), condition: CONDITION.optional() })).min(1), validUntil: z.string(), onInvalidation: z.enum(["notify", "pause_issuance", "draft_exit"]).default("notify") } },
    async (a) => call(c, "POST /v1/theses", "POST", "/v1/theses", a, (b) => `thesis ${String(b["id"])} ${String(b["status"] ?? "unknown")} on task ${a.taskId}, valid until ${a.validUntil}`),
  );
  server.registerTool(
    "add_thesis_review_item",
    { title: "Add a thesis review item", description: "POST /v1/theses/:id/review-items. Appends a support/counter item with a source URL to a research premise. Owner/agent only; never triggers execution.", inputSchema: { thesisId: z.string().min(1), premiseId: z.string().min(1), side: z.enum(["support", "counter"]), text: z.string().min(1), sourceUrl: z.string().url() } },
    async (a) => call(c, "POST /v1/theses/:id/review-items", "POST", `/v1/theses/${a.thesisId}/review-items`, { premiseId: a.premiseId, side: a.side, text: a.text, sourceUrl: a.sourceUrl, addedBy: "agent" }, () => `review item added to ${a.thesisId}`),
  );

  server.registerTool(
    "explain_task_wait",
    { title: "Explain why a task is waiting (C9)", description: "GET /v1/tasks/:id/explain-wait. ALL blockers with evidence time, nextCheckAt and whether the user must act. A wait is a correct outcome, not a failure.", inputSchema: { taskId: z.string().min(1) } },
    async (a) => call(c, "GET /v1/tasks/:id/explain-wait", "GET", `/v1/tasks/${a.taskId}/explain-wait`, undefined, (b) => { const bl = (b["blockers"] as Array<{ code: string }> | undefined) ?? []; return `${bl.length} blocker(s): ${bl.map((x) => x.code).join(", ") || "none"}; nextCheckAt ${String(b["nextCheckAt"] ?? "unknown")}; userActionRequired ${String(b["userActionRequired"] ?? false)}`; }),
  );
  server.registerTool(
    "compare_task_policies",
    { title: "Compare two condition sets on the same evidence (SIMULATION)", description: "POST /v1/tasks/:id/compare-policies. Evaluates each variant against the SAME evidence snapshot (context + events + quotes). Never changes the real task, never writes an authorization, never outputs returns.", inputSchema: { taskId: z.string().min(1), variants: z.array(z.object({ label: z.string(), conditions: CONDITIONS })).min(2).max(4) } },
    async (a) => call(c, "POST /v1/tasks/:id/compare-policies", "POST", `/v1/tasks/${a.taskId}/compare-policies`, { variants: a.variants }, (b) => `comparison ${String(b["id"])} on snapshot ${String(b["evidenceSnapshotId"])}: ${((b["variants"] as Array<{ label: string; outcome: string }> | undefined) ?? []).map((v) => `${v.label}=${v.outcome}`).join(", ")} (SIMULATION)`),
  );
  server.registerTool(
    "replay_policy",
    { title: "Replay a policy over archived evidence (no look-ahead)", description: "POST /v1/replays (or GET /v1/replays/:id with replayId). Uses only information known at each point in time (events by firstKnownAt, values by receivedAt). Gaps (NO_ARCHIVE / NO_QUOTE / REFERENCE_PURGED) are reported as gaps. No returns are computed.", inputSchema: { replayId: z.string().optional(), playbookId: PLAYBOOK.optional(), conditions: CONDITIONS.optional(), assetKey: ASSET_KEY.optional(), from: z.string().optional(), to: z.string().optional() } },
    async (a) => {
      if (a.replayId) return call(c, "GET /v1/replays/:id", "GET", `/v1/replays/${a.replayId}`, undefined, (b) => `replay ${String(b["id"])}: ${((b["points"] as unknown[] | undefined) ?? []).length} point(s), ${((b["gaps"] as unknown[] | undefined) ?? []).length} gap(s)`);
      if (!a.playbookId || !a.conditions || !a.assetKey || !a.from || !a.to) return fail("input_required", "give replayId, or playbookId + conditions + assetKey + from + to");
      return call(c, "POST /v1/replays", "POST", "/v1/replays", { playbookId: a.playbookId, conditions: a.conditions, assetKey: a.assetKey, from: a.from, to: a.to }, (b) => `replay ${String(b["id"])}: ${((b["points"] as unknown[] | undefined) ?? []).length} point(s), ${((b["gaps"] as unknown[] | undefined) ?? []).length} gap(s) (REPLAY, no look-ahead)`);
    },
  );

  server.registerTool("preview_rebalance", { title: "Preview a rebalance (C3)", description: "POST /v1/rebalance/preview. Sell-then-buy legs, each leg its own authorization, buying power recomputed after sells; partial completion allowed. Nothing is signed.", inputSchema: { owner: ADDR, targets: z.array(z.object({ assetKey: ASSET_KEY, weightBps: z.number().int().min(0).max(10000) })).min(1), inputAssetKey: ASSET_KEY, cashFloorRaw: z.string().regex(/^\d+$/).optional() } }, async (a) => call(c, "POST /v1/rebalance/preview", "POST", "/v1/rebalance/preview", a, (b) => `${((b["legs"] as unknown[] | undefined) ?? []).length} leg(s) previewed`));
  server.registerTool("create_rebalance_plan", { title: "Create a rebalance plan (C3)", description: "POST /v1/rebalance/plans (or GET /v1/rebalance/plans/:id with planId). Creates the multi-leg plan; each leg still needs its own signed TradeMandate.", inputSchema: { planId: z.string().optional(), owner: ADDR.optional(), targets: z.array(z.object({ assetKey: ASSET_KEY, weightBps: z.number().int().min(0).max(10000) })).optional(), inputAssetKey: ASSET_KEY.optional(), cashFloorRaw: z.string().regex(/^\d+$/).optional() } }, async (a) => (a.planId ? call(c, "GET /v1/rebalance/plans/:id", "GET", `/v1/rebalance/plans/${a.planId}`, undefined, (b) => `rebalance plan ${String(b["id"])}`) : call(c, "POST /v1/rebalance/plans", "POST", "/v1/rebalance/plans", a, (b) => `rebalance plan ${String(b["id"])} created (${((b["legs"] as unknown[] | undefined) ?? []).length} leg(s))`)));

  server.registerTool("get_budget_group", { title: "Get a shared budget group (C8)", description: "GET /v1/budget-groups/:id. Cap, cash floor, period, and allocations (reserved / waiting / released / settled). Invariant: spentThisPeriod + Σ reserved ≤ cap.", inputSchema: { groupId: z.string().min(1) } }, async (a) => call(c, "GET /v1/budget-groups/:id", "GET", `/v1/budget-groups/${a.groupId}`, undefined, (b) => `budget group ${String(b["id"])}: cap ${String(b["capRaw"])}, floor ${String(b["cashFloorRaw"])}, ${((b["allocations"] as unknown[] | undefined) ?? []).length} allocation(s)`));
  server.registerTool("create_budget_group", { title: "Create a shared budget group (C8)", description: "POST /v1/budget-groups. Several tasks/agents share one cap; reservations go by priority then createdAt; a task that gets no reservation waits (BUDGET_GROUP_CONFLICT).", inputSchema: { owner: ADDR, name: z.string().min(1), inputAssetKey: ASSET_KEY, periodStart: z.string(), periodEnd: z.string(), capRaw: z.string().regex(/^\d+$/), cashFloorRaw: z.string().regex(/^\d+$/).default("0") } }, async (a) => call(c, "POST /v1/budget-groups", "POST", "/v1/budget-groups", { ...a, priorityRule: "priority_then_created" }, (b) => `budget group ${String(b["id"])} created`));

  server.registerTool("get_portfolio", { title: "Get portfolio (C4)", description: "GET /v1/portfolio/:owner. Balances with block number, traceable cost coverage (unknown ≠ zero), user-reported overrides flagged user_reported, issuer unit adjustments annotated.", inputSchema: { owner: ADDR } }, async (a) => call(c, "GET /v1/portfolio/:owner", "GET", `/v1/portfolio/${a.owner}`, undefined, (b) => `portfolio @ block ${String(b["blockNumber"] ?? "?")}: ${((b["holdings"] as unknown[] | undefined) ?? []).length} holding(s)`));
  server.registerTool("report_cost_override", { title: "Report a cost basis (user_reported)", description: "POST /v1/portfolio/:owner/cost-overrides. Self-reported cost for quantity the service cannot trace; always labelled user_reported.", inputSchema: { owner: ADDR, assetKey: ASSET_KEY, qtyRaw: z.string().regex(/^\d+$/), costUsd: z.string().regex(/^\d+(\.\d+)?$/), note: z.string().max(200).optional() } }, async (a) => call(c, "POST /v1/portfolio/:owner/cost-overrides", "POST", `/v1/portfolio/${a.owner}/cost-overrides`, { assetKey: a.assetKey, qtyRaw: a.qtyRaw, costUsd: a.costUsd, note: a.note }, () => `cost override recorded (user_reported)`));

  server.registerTool("register_webhook", { title: "Register a notification webhook (C4)", description: "POST /v1/notify/webhooks. HMAC-SHA256 signed payloads; 3 retries then disabled. Payloads carry ids, type, version, summary and a link — never a signature, certificate or calldata (D-087). Duplicates cannot cause duplicate steps.", inputSchema: { url: z.string().url(), secret: z.string().min(16), types: z.array(z.string()).optional() } }, async (a) => call(c, "POST /v1/notify/webhooks", "POST", "/v1/notify/webhooks", a, (b) => `webhook ${String(b["id"])} registered`));
  server.registerTool("link_telegram", { title: "Link Telegram (C4)", description: "POST /v1/notify/telegram/link. Returns a one-time link code to send to the Chaconne bot; notifications are wake-ups only.", inputSchema: {} }, async () => call(c, "POST /v1/notify/telegram/link", "POST", "/v1/notify/telegram/link", {}, (b) => `telegram link code ${String(b["code"])} (expires ${String(b["expiresAt"] ?? "?")})`));

  server.registerTool(
    "executor_heartbeat",
    { title: "Executor heartbeat", description: "POST /v1/mandates/:id/executor/heartbeat (204). In agent-wallet mode this is sent automatically every 60 s for every mandate this process authorized or executed; call it manually to add/remove a mandate from that loop or to send one beat now. Carries no permission.", inputSchema: { mandateId: z.string().min(1), watch: z.boolean().default(true).describe("keep beating every 60 s (agent-wallet mode only)") } },
    async (a) => {
      if (!d.heartbeat) {
        const r = await c.call("POST", `/v1/mandates/${a.mandateId}/executor/heartbeat`, { at: new Date().toISOString() });
        if (isNotAvailable(r)) return notAvailable("POST /v1/mandates/:id/executor/heartbeat", r);
        return ok(`heartbeat sent (${r.status}); automatic loop needs agent-wallet mode`, { status: r.status, watching: [] });
      }
      if (a.watch) d.heartbeat.watch(a.mandateId);
      else d.heartbeat.unwatch(a.mandateId);
      const r = await d.heartbeat.beat(a.mandateId);
      if (r.notAvailable) return { ...notAvailable("POST /v1/mandates/:id/executor/heartbeat", { status: r.status, body: null, paymentRequired: null, paymentResponse: null }), structuredContent: { status: "not_available", endpoint: "POST /v1/mandates/:id/executor/heartbeat", httpStatus: r.status, watching: d.heartbeat.watching } };
      return ok(`heartbeat ${a.mandateId} → ${r.status}; watching ${d.heartbeat.watching.length} mandate(s) every 60 s`, { status: r.status, watching: d.heartbeat.watching });
    },
  );

  /* ---------------- CV-D16 批次 4：agent 自主决策（意图 / 状态 / 执行） ---------------- */

  const DECISION = z.object({
    rationale: z.string().min(1).max(2000).describe("why now, why this asset, why this amount"),
    claims: z.array(z.object({ kind: z.enum(["platform_fact", "agent_data", "agent_research"]), text: z.string().min(1).max(500), source: z.object({ evidenceId: z.string().optional(), url: z.string().max(500).optional(), name: z.string().max(100).optional() }).optional(), observedAt: z.string().optional() })).max(32).default([]).describe("each basis, classified: platform_fact needs source.evidenceId from Chaconne evidence; agent_data / agent_research are recorded as unverified and only admitted by the task's trustTier"),
    alternatives: z.array(z.string().max(500)).max(8).optional(),
    revisionOf: z.string().optional().describe("previous intent id this revises"),
  });
  const intentSummary = (b: Record<string, unknown>): string => {
    const it = b["intent"] as { id?: string; status?: string; checks?: Array<{ id: string; ok: boolean; reasons: Array<{ code: string }> }>; step?: { stepIndex?: number } | null } | undefined;
    const failed = (it?.checks ?? []).filter((c) => !c.ok).map((c) => `${c.id}${c.reasons.length ? `(${[...new Set(c.reasons.map((r) => r.code))].join(",")})` : ""}`);
    return `intent ${String(it?.id)} ${String(it?.status)}${it?.step ? ` → step ${it.step.stepIndex} certificate issued (guardCall included; signing a certificate is not sending a transaction — execute it with execute_trade_intent or your wallet)` : ""}${failed.length ? `; failed checks: ${failed.join("; ")}` : ""}; task ${String(b["taskStatus"])}`;
  };

  server.registerTool(
    "submit_trade_intent",
    {
      title: "Submit a trade intent with your decision record (CV-D16)",
      description: "POST /v1/tasks/:id/intents. You propose WHAT to buy and HOW MUCH inside the task's signed scope, plus a decision record (rationale + classified claims). Chaconne runs four checks — facts (which claims the trust tier admits; platform_fact claims are matched to evidence ids), scope (asset set, per-step cap, remaining budget, steps, deadline, allowSell, signed hard constraints), execution (same engine as the toolbox: route / quote / price impact / reference by the task policy) and binding (certificate ↔ mandate ↔ task) — and only then signs a step certificate (LIVE) or reports `simulated` (SIMULATION). Any failed check → HTTP 422 with the intent recorded as `rejected` and every reason listed; the decision record is never a pass. Plan conditions do not block an intent; deviations are recorded as planDeviations. A certificate lives ~120 s: execute it right away (execute_trade_intent in agent-wallet mode).",
      inputSchema: { taskId: z.string().min(1), clientRequestId: z.string().min(1).max(128), kind: z.enum(["buy", "sell"]).default("buy"), outputAssetKey: ASSET_KEY, amountInRaw: UINT.describe("input-token raw amount (≤ scope.perStepCapRaw)"), decision: DECISION },
    },
    async (a) => {
      const r = await c.call<Record<string, unknown>>("POST", `/v1/tasks/${a.taskId}/intents`, { clientRequestId: a.clientRequestId, kind: a.kind, outputAssetKey: a.outputAssetKey, amountInRaw: a.amountInRaw, decision: a.decision });
      if (isNotAvailable(r)) return notAvailable("POST /v1/tasks/:id/intents", r);
      if (r.status === 422 && r.body["intent"]) return ok(intentSummary(r.body), { ...r.body, httpStatus: 422 });
      if (r.status !== 200 && r.status !== 201) return fromHttp(r, () => "");
      const mid = (r.body["intent"] as { step?: { mandateId?: string } | null } | undefined)?.step?.mandateId;
      if (mid) d.heartbeat?.watch(mid);
      return ok(intentSummary(r.body), { ...r.body, httpStatus: r.status });
    },
  );

  server.registerTool(
    "get_task_intents",
    { title: "List a task's trade intents (or one intent, optionally with its live certificate)", description: "GET /v1/tasks/:id/intents, or GET /v1/tasks/:id/intents/:intentId (with `withStep=true` the response carries the READY body again while the step certificate is still PREPARED and unexpired). Shows every intent's decision record, claim triage (platform_verified / platform_unknown_evidence / agent_provided_unverified / not_admissible), the four checks with reasons, planDeviations and the issued step.", inputSchema: { taskId: z.string().min(1), intentId: z.string().optional(), withStep: z.boolean().default(false) } },
    async (a) => a.intentId
      ? call(c, "GET /v1/tasks/:id/intents/:intentId", "GET", `/v1/tasks/${a.taskId}/intents/${a.intentId}${a.withStep ? "?step=1" : ""}`, undefined, (b) => `intent ${String(b["id"])} ${String(b["status"])}${b["ready"] ? " (certificate still valid; READY body attached)" : ""}`)
      : call(c, "GET /v1/tasks/:id/intents", "GET", `/v1/tasks/${a.taskId}/intents`, undefined, (b) => { const list = (b["intents"] as Array<{ status: string }> | undefined) ?? []; return `${list.length} intent(s): ${["certified", "simulated", "rejected", "withdrawn"].map((k) => `${k} ${list.filter((x) => x.status === k).length}`).join(", ")}`; }),
  );

  server.registerTool(
    "withdraw_trade_intent",
    { title: "Withdraw a trade intent", description: "POST /v1/tasks/:id/intents/:intentId/withdraw. Voids the step certificate server-side if it was not submitted. " + D088_NOTE, inputSchema: { taskId: z.string().min(1), intentId: z.string().min(1) } },
    async (a) => call(c, "POST /v1/tasks/:id/intents/:intentId/withdraw", "POST", `/v1/tasks/${a.taskId}/intents/${a.intentId}/withdraw`, {}, (b) => `intent ${a.intentId} withdrawn${b["stepVoided"] ? "; pending certificate voided" : ""}; task ${String(b["taskStatus"])} — ${D088_NOTE}`),
  );

  server.registerTool(
    "report_agent_status",
    {
      title: "Take over a task or report your status (accepted / declined / needs evidence / plan revised / ended)",
      description: "POST /v1/tasks/:id/agent-status. First call `accepted` with your agent name to take the task over (the owner sees who is handling it and your last response time). When the task wakes you (agentTurn.state=awaiting_agent: conditions clear, blockers changed, step confirmed) and you decide NOT to submit an intent, say so — all four are normal outcomes and are recorded on the task timeline and sent to the owner: `declined` (not now, with why), `needs_evidence` (what you want to see), `plan_revised` (new plan conditions — outside the signed scope, so no re-signing; touching a signed hard constraint is refused with scope_locked), `ended` (you are done: the task is paused service-side; the owner cancels / revokes on-chain). Silence past agentTurn.respondBy is recorded as no_response and nothing happens.",
      inputSchema: { taskId: z.string().min(1), status: z.enum(["accepted", "declined", "needs_evidence", "plan_revised", "ended"]), note: z.string().min(1).max(1000), agent: z.object({ name: z.string().min(1).max(100) }).optional().describe("who you are; REQUIRED for accepted (take over the task), recommended on every report"), requestedEvidence: z.array(z.string().max(300)).max(8).optional(), plan: z.object({ conditions: z.array(CONDITION).min(1).optional(), text: z.string().max(2000).optional().describe("your current plan in plain words: what to research, which assets, how to use the remaining budget") }).optional().describe("plan_revised needs conditions, text or strategy"), strategy: z.string().max(4000).optional().describe("revised strategy text (kept as a new version)") },
    },
    async (a) => call(c, "POST /v1/tasks/:id/agent-status", "POST", `/v1/tasks/${a.taskId}/agent-status`, { status: a.status, note: a.note, agent: a.agent, requestedEvidence: a.requestedEvidence, plan: a.plan, strategy: a.strategy }, (b) => `agent ${a.status} recorded (turn ${String((b["agentTurn"] as { version?: number } | undefined)?.version ?? "?")}); task ${String((b["task"] as { status?: string } | undefined)?.status)}${b["note"] ? ` — ${String(b["note"])}` : ""}`),
  );

  server.registerTool(
    "execute_trade_intent",
    {
      title: "Execute a certified trade intent (agent-wallet mode)",
      description: "Fetches the intent with its live READY body (GET /v1/tasks/:id/intents/:intentId?step=1), runs the same local and on-chain checks as execute_next_step (mandate digest, step index vs PlanGuard.mandateState, per-step cap, validity, output set, chain allowlist), pre-approves perStepCap, sends PlanGuard.executeStep and reports the tx hash. Refuses without agent-wallet mode, or when the certificate has expired (submit a new intent). Signing a certificate never sends a transaction by itself — this tool does.",
      inputSchema: { taskId: z.string().min(1), intentId: z.string().min(1), dryRun: z.boolean().default(false) },
    },
    async (a) => {
      if (!d.wallet) return fail("agent_wallet_disabled", "execute_trade_intent needs agent-wallet mode (AGENT_WALLET_PRIVATE_KEY + AGENT_WALLET_MAX_SPEND_USD + AGENT_WALLET_CHAIN_IDS). Otherwise execute the guardCall from submit_trade_intent with the owner's wallet.");
      const r = await c.call<Record<string, unknown>>("GET", `/v1/tasks/${a.taskId}/intents/${a.intentId}?step=1`);
      if (isNotAvailable(r)) return notAvailable("GET /v1/tasks/:id/intents/:intentId", r);
      if (r.status !== 200) return fromHttp(r, () => "");
      const ready = r.body["ready"] as Record<string, unknown> | null | undefined;
      const st = r.body["step"] as { mandateId?: string; stepIndex?: number } | null | undefined;
      if (r.body["status"] !== "certified" || !st?.mandateId) return fail("intent_not_certified", `intent ${a.intentId} is ${String(r.body["status"])}; only a certified intent can be executed`, { intent: r.body });
      if (!ready || ready["status"] !== "READY") return fail("certificate_expired", "the step certificate is no longer valid (≈120 s TTL); submit a new intent", { intent: r.body });
      const mandate = ready["mandate"] as Record<string, unknown>;
      const typed = ready["typedData"] as { domain: Record<string, unknown> } | undefined;
      const domain = { ...(typed?.domain ?? {}), verifyingContract: String(ready["planGuard"] ?? (typed?.domain as { verifyingContract?: string } | undefined)?.verifyingContract ?? "") };
      let preApprove: { approveTxHash: Hex | null; allowance: string; error?: string } | null = null;
      const chainId = Number((domain as { chainId?: number })["chainId"] ?? 0);
      if (!a.dryRun && chainId && d.wallet.allowsChain(chainId) && String(mandate["owner"]).toLowerCase() === d.wallet.address.toLowerCase()) {
        try {
          const pa = await d.wallet.ensureAllowance({ chainId, token: mandate["inputToken"] as Hex, owner: mandate["owner"] as Hex, spender: domain.verifyingContract as Hex, minAmount: BigInt(String(mandate["perStepCap"])) });
          preApprove = { approveTxHash: pa.approveTxHash, allowance: pa.allowance.toString() };
        } catch (e) {
          preApprove = { approveTxHash: null, allowance: "unknown", error: e instanceof Error ? e.message.slice(0, 200) : String(e) };
        }
      }
      return executePreparedStep({ wallet: d.wallet, chainId, heartbeat: d.heartbeat }, c, ready, { mandateId: st.mandateId, mandate: { domain, message: mandate }, mandateSignature: String(ready["mandateSignature"] ?? ""), outputSet: (ready["outputSet"] as string[] | undefined) ?? [], expectedStepIndex: st.stepIndex, dryRun: a.dryRun }, preApprove);
    },
  );
}
