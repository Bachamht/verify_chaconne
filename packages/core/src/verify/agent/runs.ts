/**
 * 托管 Agent 轮次队列的纯规则（开发计划 §2.6 / §3.3 A2）：领取资格、节流、成本上限、轮次与动作绑定、续跑消息截断。
 * 服务端（apps/verify-service/src/agent）读库后调用这些函数做决定；这里不碰 I/O。
 */
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils";
import type { AgentRunState } from "../contracts";

/** 轮次租约（CV-D25）：领取后 240 s；checkpoint 续租 */
export const RUN_LEASE_MS = 240_000;
/** 同一 (taskId, turnVersion) 最多尝试 3 次（模型故障 / 租约过期都算一次） */
export const RUN_MAX_ATTEMPTS = 3;
/** FAILED 之后至少等 5 分钟才可再领 */
export const RUN_RETRY_AFTER_MS = 5 * 60_000;
/** 观察模式（SIMULATION 托管）每任务最多 6 轮 */
export const SIM_MAX_RUNS_PER_TASK = 6;
/** 续跑用的完整消息上限 */
export const RUN_MESSAGES_MAX_BYTES = 256 * 1024;
/** 意图被拒后同一轮最多再改一次 → 每轮最多 2 条被拒意图 */
export const MAX_REJECTED_INTENTS_PER_TURN = 2;

/** 低优先级原因：同一任务两轮间隔 ≥ AGENT_MIN_RUN_INTERVAL_S；其余（assigned / authorized / data_arrived / execution_failed / step_confirmed / scheduled / ready_for_intent）不受限 */
export const LOW_PRIORITY_TURN_REASONS: ReadonlySet<string> = new Set(["observation_changed", "event"]);

export const ACTIVE_RUN_STATES: ReadonlySet<AgentRunState> = new Set<AgentRunState>(["CLAIMED", "RUNNING"]);
export const FINAL_RUN_STATES: ReadonlySet<AgentRunState> = new Set<AgentRunState>(["COMPLETED", "INCOMPLETE", "CANCELLED"]);

/** 一次性轮次令牌只存 sha256（hex） */
export function runTokenHash(token: string): string {
  return bytesToHex(sha256(utf8ToBytes(token)));
}

export interface CostCaps {
  perTaskMicros: bigint;
  liveTotalMicros: bigint;
  simTotalMicros: bigint;
}
export interface CostToday {
  taskMicros: bigint;
  liveTotalMicros: bigint;
  simTotalMicros: bigint;
}

export type ClaimSkip = "low_priority_interval" | "task_daily_cap" | "live_daily_cap" | "sim_daily_cap" | "sim_run_limit" | "attempts_exhausted" | "retry_backoff" | "run_active" | "run_final";

export interface ClaimCandidate {
  mode: "LIVE" | "SIMULATION";
  reason: string;
  /** 同任务上一轮开始时刻（ms），没有则 null */
  lastRunStartedMs: number | null;
  /** 同任务已有轮次数（观察模式上限用） */
  runsForTask: number;
  /** 该 (task, turnVersion) 已有的轮次行（没有则 null） */
  existing: { state: AgentRunState; attempt: number; leaseUntilMs: number | null; updatedMs: number } | null;
}

/**
 * 领取资格：
 *  - 已有行：活跃且租约未过 → run_active；终态 → run_final；尝试次数用完 → attempts_exhausted；FAILED 未过 5 分钟 → retry_backoff
 *  - 新行：观察模式 6 轮上限；低优先级原因的最小间隔
 *  - 成本：任务 / LIVE / SIM 三个日上限分开（观察模式花不到 LIVE 的预算）
 */
export function claimSkipReason(c: ClaimCandidate, cost: CostToday, caps: CostCaps, nowMs: number, minIntervalMs: number): ClaimSkip | null {
  if (c.existing) {
    const e = c.existing;
    if (FINAL_RUN_STATES.has(e.state)) return "run_final";
    if (ACTIVE_RUN_STATES.has(e.state) && e.leaseUntilMs !== null && e.leaseUntilMs > nowMs) return "run_active";
    if (e.attempt >= RUN_MAX_ATTEMPTS) return "attempts_exhausted";
    if (e.state === "FAILED" && nowMs - e.updatedMs < RUN_RETRY_AFTER_MS) return "retry_backoff";
  } else {
    if (c.mode === "SIMULATION" && c.runsForTask >= SIM_MAX_RUNS_PER_TASK) return "sim_run_limit";
    if (LOW_PRIORITY_TURN_REASONS.has(c.reason) && c.lastRunStartedMs !== null && nowMs - c.lastRunStartedMs < minIntervalMs) return "low_priority_interval";
  }
  if (cost.taskMicros >= caps.perTaskMicros) return "task_daily_cap";
  if (c.mode === "LIVE" && cost.liveTotalMicros >= caps.liveTotalMicros) return "live_daily_cap";
  if (c.mode === "SIMULATION" && cost.simTotalMicros >= caps.simTotalMicros) return "sim_daily_cap";
  return null;
}

/** 成本上限导致的跳过（→ needs_operator: agent_budget_exhausted） */
export function isBudgetSkip(s: ClaimSkip | null): boolean {
  return s === "task_daily_cap" || s === "live_daily_cap" || s === "sim_daily_cap";
}

/* ---------------- 轮次与动作绑定（CV-D25） ---------------- */

export interface RecordedTurnAction {
  kind: "intent" | "status";
  ref: string;
  status: string;
  clientRequestId: string | null;
}
export interface TurnActionState {
  /** 已记录的终结动作（认证 / 模拟的意图，或状态报告） */
  terminal: RecordedTurnAction | null;
  /** 本轮被拒的意图数 */
  rejectedIntents: number;
}

/** 意图状态 → 是否终结动作：被拒的意图是信息（同轮可改一次），不终结轮次 */
export function isTerminalIntentStatus(status: string): boolean {
  return status === "certified" || status === "simulated";
}

export type TurnActionDecision = { kind: "accept" } | { kind: "replay"; recorded: RecordedTurnAction } | { kind: "conflict"; code: "turn_already_answered"; recorded: RecordedTurnAction } | { kind: "conflict"; code: "intent_revision_limit"; recorded: null };

/**
 * 托管轮次每个 (taskId, turnVersion) 只接受一个终结动作：
 *  - 已有终结动作且 clientRequestId 相同 → replay（幂等重放，返回原记录）
 *  - 已有终结动作且不同 → 409 turn_already_answered（带回已记录的动作）
 *  - 意图：本轮已被拒 2 次 → 409 intent_revision_limit（改报状态）
 */
export function decideTurnAction(state: TurnActionState, incoming: { kind: "intent" | "status"; clientRequestId: string | null }): TurnActionDecision {
  if (state.terminal) {
    if (incoming.clientRequestId && state.terminal.clientRequestId === incoming.clientRequestId) return { kind: "replay", recorded: state.terminal };
    return { kind: "conflict", code: "turn_already_answered", recorded: state.terminal };
  }
  if (incoming.kind === "intent" && state.rejectedIntents >= MAX_REJECTED_INTENTS_PER_TURN) return { kind: "conflict", code: "intent_revision_limit", recorded: null };
  return { kind: "accept" };
}

/* ---------------- 续跑消息截断 ---------------- */

/** 模型消息的最小形状（Messages API：role + content 数组；工具结果块 type=tool_result） */
export interface StoredMessage {
  role: "user" | "assistant";
  content: unknown;
}

/** 消息 JSON 超过上限时，从最旧的工具结果开始把内容替换成占位（保持块结构，tool_use_id 配对不坏） */
export function truncateMessages(messages: readonly StoredMessage[], maxBytes: number = RUN_MESSAGES_MAX_BYTES): { messages: StoredMessage[]; truncated: number } {
  const out: StoredMessage[] = JSON.parse(JSON.stringify(messages)) as StoredMessage[];
  const size = () => new TextEncoder().encode(JSON.stringify(out)).length;
  let truncated = 0;
  if (size() <= maxBytes) return { messages: out, truncated };
  for (const m of out) {
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content as Array<Record<string, unknown>>) {
      if (block["type"] !== "tool_result" || block["content"] === "[truncated: older tool result]") continue;
      block["content"] = "[truncated: older tool result]";
      truncated += 1;
      if (size() <= maxBytes) return { messages: out, truncated };
    }
  }
  // 仍超限：丢掉最早的成对消息（保留第一条用户消息 = 决策上下文）
  while (size() > maxBytes && out.length > 3) {
    out.splice(1, 2);
    truncated += 1;
  }
  return { messages: out, truncated };
}
