/**
 * v7 R4 · 夜班日志的 Agent 段（开发计划 §3.6 R4，供 Lane P 的 P5 / P-06 页面）：按**纽约交易日**（America/New_York 自然日，夏令时由 window.ts 处理）
 * 聚合该 owner 全部任务的：轮次、动作、等待理由、成交、成本、故障与恢复。
 *
 * 数据源全部是已有表：verify_agent_runs（轮次 / 成本）、verify_task_timeline（动作 / 等待 / 故障 / 恢复，按 categoryOf 分类）、
 * verify_mandate_steps + verify_mandates（成交：CONFIRMED 且确认时刻落在当日）。只读、不改任何行；没有数据的段给空数组（不编造）。
 * 只给 owner 本人（RecapsService 的 assertOwner）；公开分享视图（publicRecapView）不含本段。
 */
import { and, eq, gte, inArray, lt } from "drizzle-orm";
import type { Db } from "@chaconne/db";
import { verifyAgentRuns, verifyMandateSteps, verifyMandates, verifyTaskTimeline, verifyTasks } from "@chaconne/db";
import { categoryOf } from "../records/activity";

export interface AgentJournalRun {
  taskId: string;
  runId: string;
  turnVersion: number;
  reason: string;
  mode: string;
  state: string;
  at: string;
  model: string | null;
  action: { kind: string; ref: string; status: string } | null;
  decisionSummary: string | null;
  nextCheckAt: string | null;
  costUsdMicros: string | null;
}
export interface AgentJournalEvent {
  taskId: string;
  at: string;
  type: string;
  actor: string;
  note: string | null;
}
export interface AgentJournalWait extends AgentJournalEvent {
  /** 等待来源：时间线条目或轮次的状态动作 */
  source: "timeline" | "run";
  nextCheckAt: string | null;
  invalidation: string | null;
}
export interface AgentJournalFill {
  taskId: string;
  mandateId: string;
  side: "buy" | "sell";
  stepIndex: number;
  at: string;
  spentRaw: string | null;
  receivedRaw: string | null;
  txHash: string | null;
}
export interface AgentJournalDay {
  date: string;
  tz: "America/New_York";
  window: { startUtc: string; endUtc: string };
  taskIds: string[];
  runs: { total: number; byState: Record<string, number>; byReason: Record<string, number>; byMode: Record<string, number>; items: AgentJournalRun[] };
  actions: { total: number; byType: Record<string, number>; items: AgentJournalEvent[] };
  waits: AgentJournalWait[];
  fills: AgentJournalFill[];
  cost: { totalUsdMicros: string; byMode: Record<string, string>; inputTokens: number; outputTokens: number; cacheReadTokens: number; runsWithoutCost: number };
  faults: AgentJournalEvent[];
  recoveries: AgentJournalEvent[];
}

const bump = (m: Record<string, number>, k: string) => {
  m[k] = (m[k] ?? 0) + 1;
};
const n = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) ? v : 0);
const isDecimalInt = (v: unknown): v is string => typeof v === "string" && /^\d+$/.test(v);

/** 轮次状态动作里属于「等待」的状态（其余为决定） */
const WAIT_STATUSES = new Set(["waiting", "needs_evidence", "declined"]);

/** onlyCallerId：调用方不代表该 owner 时（配置表里的固定 key），只聚合它自己建的任务（与 mandatesForOwner 的隔离一致） */
export async function buildAgentJournal(db: Db, owner: string, date: string, dayStartUtc: Date, dayEndUtc: Date, onlyCallerId: string | null = null): Promise<AgentJournalDay> {
  const o = owner.toLowerCase();
  const tasks = await db.select({ id: verifyTasks.id }).from(verifyTasks).where(onlyCallerId ? and(eq(verifyTasks.ownerAddress, o), eq(verifyTasks.callerId, onlyCallerId)) : eq(verifyTasks.ownerAddress, o));
  const taskIds = tasks.map((t) => t.id);
  const empty: AgentJournalDay = {
    date,
    tz: "America/New_York",
    window: { startUtc: dayStartUtc.toISOString(), endUtc: dayEndUtc.toISOString() },
    taskIds: [],
    runs: { total: 0, byState: {}, byReason: {}, byMode: {}, items: [] },
    actions: { total: 0, byType: {}, items: [] },
    waits: [],
    fills: [],
    cost: { totalUsdMicros: "0", byMode: {}, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, runsWithoutCost: 0 },
    faults: [],
    recoveries: [],
  };
  if (taskIds.length === 0) return empty;

  const [runRows, tlRows, mandateRows] = await Promise.all([
    db
      .select({ id: verifyAgentRuns.id, taskId: verifyAgentRuns.taskId, turnVersion: verifyAgentRuns.turnVersion, reason: verifyAgentRuns.reason, mode: verifyAgentRuns.mode, state: verifyAgentRuns.state, model: verifyAgentRuns.model, actionJson: verifyAgentRuns.actionJson, decisionSummary: verifyAgentRuns.decisionSummary, nextCheckAt: verifyAgentRuns.nextCheckAt, invalidation: verifyAgentRuns.invalidation, usageJson: verifyAgentRuns.usageJson, costUsdMicros: verifyAgentRuns.costUsdMicros, startedAt: verifyAgentRuns.startedAt, endedAt: verifyAgentRuns.endedAt, createdAt: verifyAgentRuns.createdAt })
      .from(verifyAgentRuns)
      .where(inArray(verifyAgentRuns.taskId, taskIds)),
    db.select().from(verifyTaskTimeline).where(and(inArray(verifyTaskTimeline.taskId, taskIds), gte(verifyTaskTimeline.at, dayStartUtc), lt(verifyTaskTimeline.at, dayEndUtc))).orderBy(verifyTaskTimeline.id),
    db.select({ id: verifyMandates.id, taskId: verifyMandates.taskId, side: verifyMandates.side }).from(verifyMandates).where(inArray(verifyMandates.taskId, taskIds)),
  ]);

  // 轮次：以结束时刻（未结束则开始 / 创建时刻）落在当日为准
  const inDay = (d: Date) => d.getTime() >= dayStartUtc.getTime() && d.getTime() < dayEndUtc.getTime();
  const runs = runRows.filter((r) => inDay(r.endedAt ?? r.startedAt ?? r.createdAt)).sort((a, b) => (a.endedAt ?? a.startedAt ?? a.createdAt).getTime() - (b.endedAt ?? b.startedAt ?? b.createdAt).getTime());
  const out: AgentJournalDay = { ...empty, taskIds };
  let total = 0n;
  const byModeCost: Record<string, bigint> = {};
  for (const r of runs) {
    bump(out.runs.byState, r.state);
    bump(out.runs.byReason, r.reason);
    bump(out.runs.byMode, r.mode);
    const action = (r.actionJson as AgentJournalRun["action"]) ?? null;
    const at = (r.endedAt ?? r.startedAt ?? r.createdAt).toISOString();
    out.runs.items.push({ taskId: r.taskId, runId: r.id, turnVersion: r.turnVersion, reason: r.reason, mode: r.mode, state: r.state, at, model: r.model ?? null, action, decisionSummary: r.decisionSummary ?? null, nextCheckAt: r.nextCheckAt?.toISOString() ?? null, costUsdMicros: r.costUsdMicros ?? null });
    if (isDecimalInt(r.costUsdMicros)) {
      total += BigInt(r.costUsdMicros);
      byModeCost[r.mode] = (byModeCost[r.mode] ?? 0n) + BigInt(r.costUsdMicros);
    } else out.cost.runsWithoutCost += 1;
    const u = (r.usageJson ?? {}) as Record<string, unknown>;
    out.cost.inputTokens += n(u["inputTokens"]);
    out.cost.outputTokens += n(u["outputTokens"]);
    out.cost.cacheReadTokens += n(u["cacheReadTokens"]);
    if (action?.kind === "status" && WAIT_STATUSES.has(action.status)) out.waits.push({ taskId: r.taskId, at, type: `agent_${action.status}`, actor: "agent", note: r.decisionSummary ?? null, source: "run", nextCheckAt: r.nextCheckAt?.toISOString() ?? null, invalidation: r.invalidation ?? null });
    if (r.state === "FAILED") out.faults.push({ taskId: r.taskId, at, type: "run_failed", actor: "system", note: `turn ${r.turnVersion} attempt failed` });
  }
  out.runs.total = runs.length;
  out.cost.totalUsdMicros = total.toString();
  out.cost.byMode = Object.fromEntries(Object.entries(byModeCost).map(([k, v]) => [k, v.toString()]));

  // 时间线：动作（决定）/ 等待 / 故障 / 恢复
  for (const t of tlRows) {
    const ev: AgentJournalEvent = { taskId: t.taskId, at: t.at.toISOString(), type: t.type, actor: t.actor, note: t.note ?? null };
    const c = categoryOf(t.type);
    if (c === "decision" && t.type !== "agent_turn" && t.type !== "agent_tool") {
      out.actions.items.push(ev);
      bump(out.actions.byType, t.type);
    } else if (c === "wait") out.waits.push({ ...ev, source: "timeline", nextCheckAt: null, invalidation: null });
    else if (c === "fault") out.faults.push(ev);
    else if (c === "recovery") out.recoveries.push(ev);
  }
  out.actions.total = out.actions.items.length;
  out.waits.sort((a, b) => a.at.localeCompare(b.at));
  out.faults.sort((a, b) => a.at.localeCompare(b.at));

  // 成交：本任务授权的 CONFIRMED 步骤，确认时刻（回执 confirmedAt，缺省 updatedAt）落在当日
  if (mandateRows.length) {
    const steps = await db.select().from(verifyMandateSteps).where(and(inArray(verifyMandateSteps.mandateId, mandateRows.map((m) => m.id)), eq(verifyMandateSteps.state, "CONFIRMED")));
    const byId = new Map(mandateRows.map((m) => [m.id, m]));
    for (const s of steps) {
      const rj = (s.receiptJson ?? {}) as { confirmedAt?: string; event?: { spent?: string; received?: string } };
      const at = rj.confirmedAt ? new Date(rj.confirmedAt) : s.updatedAt;
      if (!inDay(at)) continue;
      const m = byId.get(s.mandateId)!;
      out.fills.push({ taskId: m.taskId!, mandateId: s.mandateId, side: m.side === "sell" ? "sell" : "buy", stepIndex: s.stepIndex, at: at.toISOString(), spentRaw: rj.event?.spent ?? null, receivedRaw: rj.event?.received ?? null, txHash: s.txHash ?? null });
    }
    out.fills.sort((a, b) => a.at.localeCompare(b.at));
  }
  return out;
}
