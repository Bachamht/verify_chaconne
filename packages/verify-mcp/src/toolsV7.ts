/**
 * v7 工具（interfaces §12.10，51 → 58）：托管 Agent 与自带 Agent 用的是同一套工具。
 *   get_turn_context        GET  /v1/tasks/:id/agent-context   （每轮第一条输入：本轮原因、阻塞项、范围、预算、持仓、记忆、理由卡、事件、证据）
 *   get_executable_quotes   POST /v1/tasks/:id/quotes          （≤ 3 项；不签发、不落授权评估；证据 15 分钟内可作为 platform_fact 引用）
 *   get_task_activity       GET  /v1/tasks/:id/activity        （增量活动流）
 *   get_task_positions      GET  /v1/tasks/:id/positions       （本任务买入形成的持仓；sellableRaw）
 *   get_task_runs           GET  /v1/tasks/:id/runs[/:runId]   （轮次摘要：模型、提示词哈希、工具调用哈希、动作、成本、哈希链）
 *   get_delegation_status   GET  /v1/tasks/:id/delegation      （委托清单与额度）
 *   remember_note           POST /v1/tasks/:id/memory          （任务记忆 ≤ 20 条 × 2 KB；不要记录密钥或个人信息）
 * 端点未部署 → not_available（不伪装）。stdout 是协议通道，日志只走 stderr。
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { VerifyClient } from "./client";
import { ASSET_KEY, UINT } from "./toolUtil";
import { call, qs } from "./toolsV6";

export const TOOL_NAMES_V7 = ["get_turn_context", "get_executable_quotes", "get_task_activity", "get_task_positions", "get_task_runs", "get_delegation_status", "remember_note"] as const;

export interface V7Deps {
  client: VerifyClient;
}

const TASK_ID = z.string().min(1).max(64).describe("task id (tsk_…)");
const CRID = z.string().regex(/^[A-Za-z0-9_\-:.]{1,128}$/).describe("idempotency key; hosted agent uses h:<runId>:<seq>");

export function registerV7Tools(server: McpServer, d: V7Deps): void {
  const c = d.client;

  server.registerTool(
    "get_turn_context",
    {
      title: "Get the decision context for this turn",
      description:
        "GET /v1/tasks/:id/agent-context. Call this first every turn. Returns: now and US session; the task objective, strategy and the SIGNED scope (assets, budget, per-step cap, steps, deadline, allowSell, trust tier, hard conditions — none of these can change); this turn's version, reason (assigned / authorized / scheduled / data_arrived / execution_failed / step_confirmed / event / observation_changed) and blockers; remaining buy budget and steps, allowances, sell readiness; task positions; the last intent and its execution job; recent decisions; task memory; the thesis card; relevant events with dataStatus (upcoming / due_pending_data / data_arrived / revised) and outcome when present; and evidence ids you may cite as platform_fact for 15 minutes. All amounts are raw smallest-unit decimal strings.",
      inputSchema: { taskId: TASK_ID },
    },
    async (a) =>
      call(c, "GET /v1/tasks/:id/agent-context", "GET", `/v1/tasks/${a.taskId}/agent-context`, undefined, (b) => {
        const turn = b["turn"] as { version?: number; reason?: string; blockers?: Array<{ code: string }> } | null;
        const budget = b["budget"] as { buyRemainingRaw?: string; buyStepsLeft?: number } | undefined;
        const session = b["session"] as { label?: string } | undefined;
        return `turn ${String(turn?.version ?? "?")} (${String(turn?.reason ?? "?")}); session ${String(session?.label ?? "?")}; blockers: ${(turn?.blockers ?? []).map((x) => x.code).join(", ") || "none"}; buy budget left ${String(budget?.buyRemainingRaw ?? "?")} raw, ${String(budget?.buyStepsLeft ?? "?")} step(s); ${((b["evidence"] as unknown[] | undefined) ?? []).length} citable evidence id(s)`;
      }),
  );

  server.registerTool(
    "get_executable_quotes",
    {
      title: "Get executable quotes (no certificate is signed)",
      description:
        "POST /v1/tasks/:id/quotes. Up to 3 items {side: buy|sell, assetKey ∈ scope, amountInRaw ≤ the per-step cap}. Uses the same evidence engine as the intent checks but signs nothing and evaluates no authorization. Returns executableUsdPerShare, priceImpactBps, minOutRaw, reference {priceUsd, kind, ageS}, deviationBps, session and evidenceIds (citable as platform_fact for 15 minutes). Served serially with a 30 s cache and at most 20 upstream quotes per task per hour (HTTP 429 beyond).",
      inputSchema: { taskId: TASK_ID, items: z.array(z.object({ side: z.enum(["buy", "sell"]).default("buy"), assetKey: ASSET_KEY, amountInRaw: UINT.describe("input amount, raw smallest units (stablecoin for buy, stock token for sell)") })).min(1).max(3) },
    },
    async (a) =>
      call(c, "POST /v1/tasks/:id/quotes", "POST", `/v1/tasks/${a.taskId}/quotes`, { items: a.items }, (b) => {
        const items = (b["items"] as Array<Record<string, unknown>> | undefined) ?? [];
        return `${items.length} quote(s): ${items.map((q) => `${String(q["side"])} ${String(q["amountInRaw"])} → $${String(q["executableUsdPerShare"] ?? "?")}/share, impact ${String(q["priceImpactBps"] ?? "?")} bps, ${String(q["verdict"] ?? "?")}${q["cached"] ? " (cached)" : ""}`).join("; ")}; ${String(b["quotaRemaining"] ?? "?")} quote(s) left this hour`;
      }),
  );

  server.registerTool(
    "get_task_activity",
    {
      title: "Get recent task activity",
      description: "GET /v1/tasks/:id/activity?since&limit. Incremental activity feed (turns, intents, execution jobs, receipts, owner actions) with a cursor and the task runtime (who decides, who executes, what it is waiting for).",
      inputSchema: { taskId: TASK_ID, since: z.string().max(64).optional().describe("cursor from a previous call"), limit: z.number().int().min(1).max(100).optional() },
    },
    async (a) => call(c, "GET /v1/tasks/:id/activity", "GET", `/v1/tasks/${a.taskId}/activity${qs({ since: a.since, limit: a.limit })}`, undefined, (b) => `${((b["items"] as unknown[] | undefined) ?? []).length} activity item(s); next cursor ${String(b["nextCursor"] ?? "none")}`),
  );

  server.registerTool(
    "get_task_positions",
    {
      title: "Get positions formed by this task",
      description: "GET /v1/tasks/:id/positions. Per stock: boughtRaw, soldRaw, netRaw, onchainRaw, sellableRaw (= min(task net position, on-chain balance); you may only sell up to this), avgCostUsd and coverage. Holdings the owner had before the task are never sellable by the agent.",
      inputSchema: { taskId: TASK_ID },
    },
    async (a) => call(c, "GET /v1/tasks/:id/positions", "GET", `/v1/tasks/${a.taskId}/positions`, undefined, (b) => { const ps = (b["positions"] as Array<{ assetKey: string; sellableRaw?: string }> | undefined) ?? []; return `${ps.length} position(s): ${ps.map((p) => `${p.assetKey.slice(-6)} sellable ${String(p.sellableRaw ?? "?")}`).join(", ") || "none"}`; }),
  );

  server.registerTool(
    "get_task_runs",
    {
      title: "Get agent run records",
      description: "GET /v1/tasks/:id/runs (or /runs/:runId). Each turn's run: model, prompt hash, tool calls (name + argument / result hashes; previews only in the detail), the one terminal action, decision summary, nextCheckAt, usage and cost, and the run hash chain (prevRunHash → runHash). Hashes prove the record is unchanged, not that the decision was right.",
      inputSchema: { taskId: TASK_ID, runId: z.string().max(64).optional() },
    },
    async (a) => (a.runId ? call(c, "GET /v1/tasks/:id/runs/:runId", "GET", `/v1/tasks/${a.taskId}/runs/${a.runId}`, undefined, (b) => `run ${String(b["runId"] ?? a.runId)} ${String(b["state"] ?? "?")}`) : call(c, "GET /v1/tasks/:id/runs", "GET", `/v1/tasks/${a.taskId}/runs`, undefined, (b) => `${((b["runs"] as unknown[] | undefined) ?? (b["items"] as unknown[] | undefined) ?? []).length} run(s)`)),
  );

  server.registerTool(
    "get_delegation_status",
    {
      title: "Get the delegation checklist",
      description: "GET /v1/tasks/:id/delegation. The one-time delegation the owner signs: buy authorization, per-stock sell authorizations and token permits, each with status (todo / submitted / confirmed / failed / not_needed), signature counts (user transactions stay 0), on-chain allowances vs required, buyReady / sellReady / complete. Read-only for agents; only the owner signs.",
      inputSchema: { taskId: TASK_ID },
    },
    async (a) => call(c, "GET /v1/tasks/:id/delegation", "GET", `/v1/tasks/${a.taskId}/delegation`, undefined, (b) => { const counts = b["counts"] as { signaturesNeeded?: number; signaturesDone?: number } | undefined; return `delegation ${b["complete"] ? "complete" : "incomplete"}: ${String(counts?.signaturesDone ?? "?")}/${String(counts?.signaturesNeeded ?? "?")} signatures; buyReady ${String(b["buyReady"] ?? "?")}`; }),
  );

  server.registerTool(
    "remember_note",
    {
      title: "Write a note to task memory",
      description: "POST /v1/tasks/:id/memory. Keeps a short fact you will need in later turns (≤ 2 KB; the task keeps the latest 20 notes, oldest dropped first). Deduplicated by clientRequestId. Never store keys, secrets or personal information.",
      inputSchema: { taskId: TASK_ID, text: z.string().min(1).max(2048), clientRequestId: CRID },
    },
    async (a) => call(c, "POST /v1/tasks/:id/memory", "POST", `/v1/tasks/${a.taskId}/memory`, { text: a.text, clientRequestId: a.clientRequestId }, (b) => `${b["duplicate"] ? "note already recorded" : "note recorded"}; task memory holds ${String(b["notes"] ?? "?")} note(s)`),
  );
}
