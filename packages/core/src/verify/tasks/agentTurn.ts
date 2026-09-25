/**
 * 唤醒通路（CV-D16 批次 3）：观察 → 通知 agent → 等 agent 的状态。
 * 只对 scope.issuance = "agent" 的任务：平台不按计划签发，而是在**观察变化**时（阻塞集合变化 / 条件清空可提交意图 /
 * 步骤确认 / 事件修订传播）开一个「轮次」（AgentTurn），发 `task.agent_turn` 通知，然后等 agent：
 *   提交交易意图（intent_received）/ 拒绝这次（declined）/ 要更多证据（needs_evidence）/ 修订计划（plan_revised）/ 结束任务（ended）。
 * 这些都是**正常结果**，不是失败；超过 respondBy 没回应记 no_response（信息项），下次观察变化再叫。
 * 轮次与 agent 是谁无关（webhook / Telegram / MCP 轮询 get_task 都能拿到）；平台从不替 agent 做决定。
 */
import type { Condition, IsoUtc } from "../contracts";

export const AGENT_TURN_REASONS = ["observation_changed", "ready_for_intent", "step_confirmed", "authorized", "event"] as const;
export type AgentTurnReason = (typeof AGENT_TURN_REASONS)[number];
export const AGENT_TURN_STATES = ["awaiting_agent", "intent_received", "accepted", "declined", "needs_evidence", "plan_revised", "ended", "no_response"] as const;
export type AgentTurnState = (typeof AGENT_TURN_STATES)[number];
export const AGENT_STATUS_REPORTS = ["accepted", "declined", "needs_evidence", "plan_revised", "ended"] as const;
export type AgentStatusKind = (typeof AGENT_STATUS_REPORTS)[number];

/** agent 回报的状态（POST /v1/tasks/:id/agent-status） */
export interface AgentStatusReport {
  status: AgentStatusKind;
  /** 一句话（≤ 1000 字）：为什么不买 / 缺什么 / 改成什么 / 为什么结束 */
  note: string;
  /** needs_evidence：想要哪些证据（自由文本，≤ 8 条） */
  requestedEvidence?: string[];
  /** plan_revised：新的计划条件（在签名之外，走 POST /v1/tasks/:id/conditions 同一套校验；硬约束不可触碰）和 / 或用人话写的当前计划 */
  plan?: { conditions?: Condition[]; text?: string };
  /** 谁在处理（accepted 时必填；其它回报可带，用于更新最近回应时间） */
  agent?: { name: string };
  /** 修订后的策略文本（agent 版本；留历史） */
  strategy?: string;
}

export interface AgentTurn {
  /** 单调递增（同一任务内） */
  version: number;
  reason: AgentTurnReason;
  /** 观察键：阻塞集合键 / "clear" / "step:<n>"；同键不重复开轮次 */
  observationKey: string;
  summary: string;
  requestedAt: IsoUtc;
  respondBy: IsoUtc;
  state: AgentTurnState;
  respondedAt: IsoUtc | null;
  /** intent_received：意图 id */
  intentId: string | null;
  response: AgentStatusReport | null;
  /** 事件观察键（批次 6）：关注的事件 `${id}@${revision}:${upcoming|released}` 列表；变化 = 事件驱动的轮次（reason=event） */
  eventsKey?: string;
}

/**
 * 任务简报（在签名之外，可改）：目标之外交给 agent 的东西——策略文本（agent 理解与运用，留版本）、关注的事件（临近 / 发布 / 修订时叫醒）、
 * 接管的 agent（页面据此显示「等待 Agent 接管」或「谁在处理、最近一次回应」）、示例来源（只是记录）。
 */
export interface StrategyVersion {
  version: number;
  text: string;
  /** owner = 用户写的；agent = agent 修订的 */
  by: "owner" | "agent";
  at: IsoUtc;
  note?: string;
}
export interface TaskBrief {
  strategy: StrategyVersion | null;
  strategyHistory: StrategyVersion[];
  /** 当前计划（agent 用人话写的：准备研究 / 买哪些 / 剩余预算怎么用）；随 plan_revised / accepted 更新 */
  currentPlan: { text: string; at: IsoUtc } | null;
  watch: { kinds: string[] };
  agent: { name: string; acceptedAt: IsoUtc; lastResponseAt: IsoUtc } | null;
  exampleId: string | null;
}
export const STRATEGY_MAX_CHARS = 4000;
export const DEFAULT_WATCH_KINDS = ["MACRO_TIER1", "EARNINGS", "FED_SPEECH"] as const;
/** 事件观察窗：过去 6 小时（刚发布）到未来 48 小时（临近） */
export const EVENT_WATCH_PAST_MS = 6 * 3600_000;
export const EVENT_WATCH_AHEAD_MS = 48 * 3600_000;

/** 默认回应窗口：30 分钟（过了只记 no_response，不做任何动作） */
export const AGENT_TURN_RESPOND_MS = 30 * 60_000;

export function resolveAgentStatusReport(raw: unknown): { ok: true; report: AgentStatusReport } | { ok: false; errors: Array<{ field: string; code: string }> } {
  const errors: Array<{ field: string; code: string }> = [];
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const status = (AGENT_STATUS_REPORTS as readonly unknown[]).includes(o["status"]) ? (o["status"] as AgentStatusKind) : null;
  if (!status) errors.push({ field: "status", code: `expected_${AGENT_STATUS_REPORTS.join("|")}` });
  const note = typeof o["note"] === "string" ? o["note"].trim() : "";
  if (!note || note.length > 1000) errors.push({ field: "note", code: "expected_string_1_to_1000" });
  let requestedEvidence: string[] | undefined;
  if (o["requestedEvidence"] !== undefined) {
    if (!Array.isArray(o["requestedEvidence"]) || o["requestedEvidence"].length > 8 || !o["requestedEvidence"].every((x) => typeof x === "string" && x.length <= 300)) errors.push({ field: "requestedEvidence", code: "expected_string_array_max_8" });
    else requestedEvidence = o["requestedEvidence"] as string[];
  }
  let plan: AgentStatusReport["plan"];
  if (o["plan"] !== undefined) {
    const p = (o["plan"] && typeof o["plan"] === "object" ? o["plan"] : null) as Record<string, unknown> | null;
    if (!p) errors.push({ field: "plan", code: "expected_object" });
    else {
      if (p["conditions"] !== undefined && !Array.isArray(p["conditions"])) errors.push({ field: "plan.conditions", code: "expected_array" });
      if (p["text"] !== undefined && (typeof p["text"] !== "string" || p["text"].length > 2000)) errors.push({ field: "plan.text", code: "expected_string_max_2000" });
      plan = { ...(Array.isArray(p["conditions"]) ? { conditions: p["conditions"] as Condition[] } : {}), ...(typeof p["text"] === "string" && p["text"].trim() ? { text: p["text"].trim() } : {}) };
    }
  }
  if (status === "plan_revised" && !plan?.conditions && !plan?.text && typeof o["strategy"] !== "string") errors.push({ field: "plan", code: "plan_revised_needs_conditions_text_or_strategy" });
  let agent: AgentStatusReport["agent"];
  if (o["agent"] !== undefined) {
    const a = (o["agent"] && typeof o["agent"] === "object" ? o["agent"] : null) as Record<string, unknown> | null;
    if (!a || typeof a["name"] !== "string" || !a["name"].trim() || a["name"].length > 100) errors.push({ field: "agent.name", code: "expected_string_1_to_100" });
    else agent = { name: a["name"].trim() };
  }
  if (status === "accepted" && !agent) errors.push({ field: "agent.name", code: "required_for_accepted" });
  let strategy: string | undefined;
  if (o["strategy"] !== undefined) {
    if (typeof o["strategy"] !== "string" || !o["strategy"].trim() || o["strategy"].length > STRATEGY_MAX_CHARS) errors.push({ field: "strategy", code: `expected_string_1_to_${STRATEGY_MAX_CHARS}` });
    else strategy = o["strategy"].trim();
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, report: { status: status!, note, ...(requestedEvidence ? { requestedEvidence } : {}), ...(plan ? { plan } : {}), ...(agent ? { agent } : {}), ...(strategy ? { strategy } : {}) } };
}
