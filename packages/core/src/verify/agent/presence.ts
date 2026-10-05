/**
 * 接管状态（开发计划 §2.1 / 上游 §4.4）：替换二态 executorPresence。纯函数，输入全部由服务端读库后给出。
 *
 * hosted 判定顺序（先命中先返回）：
 *   1. 任务 PAUSED 且 paused_by = agent             → ended（Agent 报 ended 后的内部暂停）
 *   2. 任务 PAUSED / 终态 / REVOKE_PENDING           → paused
 *   3. 有阻塞型 needsOwner                          → blocked_owner
 *   4. 有 needsOperator                             → blocked_operator（页面显示「平台在处理」）
 *   5. 有 CLAIMED / RUNNING 的轮次                   → working（currentActivity = 最近一次工具调用的人话）
 *   6. 最新意图已认证且执行作业未终结               → awaiting_fill
 *   7. 委托未完成，或从未做过决定                   → starting
 *   8. 其余                                         → waiting（waitingFor = 阻塞项 / 实际值未到 / 下次检查时刻）
 * byo：10 分钟内有回应 = online。
 */
import type { AgentPresence, AgentRunState, ExecutionJobState, HostedAgentState, IsoUtc, NeedsOperatorCode, NeedsOwnerItem } from "../contracts";

/** byo 在线窗口 */
export const BYO_ONLINE_WINDOW_MS = 10 * 60_000;
const TERMINAL_TASK: ReadonlySet<string> = new Set(["COMPLETED", "CANCELLED", "REVOKED", "EXPIRED", "FAILED", "REVOKE_PENDING", "ARCHIVED"]);
const OPEN_JOB: ReadonlySet<ExecutionJobState> = new Set<ExecutionJobState>(["QUEUED", "CLAIMED", "SENDING", "SENT"]);
const ACTIVE_RUN: ReadonlySet<AgentRunState> = new Set<AgentRunState>(["CLAIMED", "RUNNING"]);

export interface PresenceTask {
  agentMode: "hosted" | "byo" | null;
  status: string;
  pausedBy: string | null;
  nextAgentCheckAt: IsoUtc | null;
  /** 阻塞项代码（任务 blockersJson） */
  blockers: string[];
  /** byo：最近一次回应（brief.agent.lastResponseAt） */
  lastResponseAt: IsoUtc | null;
}
export interface PresenceRun {
  state: AgentRunState;
  /** 最近一次工具调用（人话），没有则 null */
  currentActivity: string | null;
  /** 最近一次有动作的轮次结束时刻 */
  lastDecisionAt: IsoUtc | null;
}
export interface PresenceIntent {
  status: string;
}
export interface PresenceJob {
  state: ExecutionJobState;
}
export interface PresenceNeeds {
  owner: NeedsOwnerItem[];
  operator: NeedsOperatorCode[];
}

const WAITING_TEXT: Record<string, string> = {
  EVENT_DATA_PENDING: "event scheduled time passed; waiting for the actual value",
  EXECUTION_IN_FLIGHT: "a certificate is in flight; waiting for it to settle or expire",
  MARKET_OUTSIDE_REGULAR: "waiting for the US regular session",
};

/** 一个人话的「在等什么」 */
function waitingForOf(task: PresenceTask): string | null {
  for (const code of task.blockers) if (WAITING_TEXT[code]) return WAITING_TEXT[code]!;
  if (task.blockers.length) return `waiting on: ${[...new Set(task.blockers)].join(", ")}`;
  if (task.nextAgentCheckAt) return `next check at ${task.nextAgentCheckAt}`;
  return null;
}

export function deriveHostedState(task: PresenceTask, run: PresenceRun | null, intent: PresenceIntent | null, job: PresenceJob | null, needs: PresenceNeeds): HostedAgentState {
  if (task.status === "PAUSED" && task.pausedBy === "agent") return "ended";
  if (task.status === "PAUSED" || TERMINAL_TASK.has(task.status)) return "paused";
  if (needs.owner.some((n) => n.blocking)) return "blocked_owner";
  if (needs.operator.length > 0) return "blocked_operator";
  if (run && ACTIVE_RUN.has(run.state)) return "working";
  if (intent?.status === "certified" && job && OPEN_JOB.has(job.state)) return "awaiting_fill";
  if (task.status === "AWAITING_AUTHORIZATION" || !run?.lastDecisionAt) return "starting";
  return "waiting";
}

export function derivePresence(task: PresenceTask, run: PresenceRun | null, intent: PresenceIntent | null, job: PresenceJob | null, needs: PresenceNeeds, nowMs: number = Date.now()): AgentPresence {
  if (task.agentMode === null) return { mode: "none", state: "unassigned" };
  if (task.agentMode === "byo") {
    const t = task.lastResponseAt ? Date.parse(task.lastResponseAt) : NaN;
    return { mode: "byo", state: Number.isFinite(t) && nowMs - t <= BYO_ONLINE_WINDOW_MS ? "online" : "offline", lastResponseAt: task.lastResponseAt, nextCheckAt: task.nextAgentCheckAt };
  }
  const state = deriveHostedState(task, run, intent, job, needs);
  return {
    mode: "hosted",
    state,
    currentActivity: state === "working" ? (run?.currentActivity ?? "thinking") : null,
    waitingFor: state === "waiting" ? waitingForOf(task) : state === "awaiting_fill" ? "the platform executor is sending the certified step" : null,
    lastDecisionAt: run?.lastDecisionAt ?? null,
    nextCheckAt: task.nextAgentCheckAt,
  };
}

/** 工具调用 → 人话（currentActivity） */
export function activityText(toolName: string | null | undefined): string | null {
  if (!toolName) return null;
  const map: Record<string, string> = {
    get_turn_context: "reading the task context",
    get_executable_quotes: "checking executable quotes",
    get_market_context: "reading market context",
    get_events: "checking the event calendar",
    explain_task_wait: "reviewing blockers",
    get_task_positions: "reviewing positions",
    get_task_activity: "reviewing recent activity",
    add_thesis_review_item: "adding a thesis review item",
    submit_trade_intent: "submitting a trade intent",
    withdraw_trade_intent: "withdrawing a trade intent",
    report_agent_status: "reporting a decision",
    remember_note: "writing a note to task memory",
    fetch_source: "reading an official source",
  };
  return map[toolName] ?? `using ${toolName}`;
}
