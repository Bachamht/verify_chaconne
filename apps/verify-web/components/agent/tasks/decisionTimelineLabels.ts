/**
 * 决策时间线（CV-D16 批次 5）的纯函数：把意图 / 轮次 / 时间线整理成页面要的形状。
 * 关键区分：「我们核验的」（platform_verified）vs「agent 提供的、未核验」（agent_provided_unverified / platform_unknown_evidence）vs「不采信」（not_admissible）。
 */
import type { AgentTradeIntent, AgentTurn, TaskTimelineEntry } from "@/lib/api-v2";
import type { Locale } from "@/lib/i18n";

export type ClaimBucket = "verified" | "agent" | "inadmissible";
export interface ClaimLine { bucket: ClaimBucket; text: string; source: string | null; kind: string }

export function claimLines(intent: AgentTradeIntent): ClaimLine[] {
  return intent.decision.claims.map((c, i) => {
    const t = intent.triage.find((x) => x.index === i);
    const bucket: ClaimBucket = !t || t.label === "not_admissible" ? "inadmissible" : t.label === "platform_verified" ? "verified" : "agent";
    const source = c.source?.evidenceId ?? c.source?.url ?? c.source?.name ?? null;
    return { bucket, text: c.text, source, kind: c.kind };
  });
}

export function bucketLabel(b: ClaimBucket, locale: Locale): string {
  const zh = locale === "zh";
  return b === "verified" ? (zh ? "我们核验过" : "verified by us") : b === "agent" ? (zh ? "agent 提供 · 未核验" : "agent-provided · unverified") : (zh ? "不采信（超出信任档位）" : "not admitted (beyond trust tier)");
}

export function checkLabel(id: string, locale: Locale): string {
  const zh = locale === "zh";
  return ({ facts: zh ? "依据分拣" : "Basis triage", scope: zh ? "授权范围与硬约束" : "Scope & hard constraints", execution: zh ? "执行核验" : "Execution check", binding: zh ? "证书绑定" : "Certificate binding" } as Record<string, string>)[id] ?? id;
}

export function intentStatusLabel(status: AgentTradeIntent["status"], locale: Locale): string {
  const zh = locale === "zh";
  return ({ certified: zh ? "已签证书" : "certified", simulated: zh ? "模拟通过" : "simulated", rejected: zh ? "被拒" : "rejected", withdrawn: zh ? "已撤回" : "withdrawn", expired: zh ? "已过期" : "expired" } as Record<string, string>)[status] ?? status;
}

export function turnStateLabel(state: AgentTurn["state"], locale: Locale): string {
  const zh = locale === "zh";
  return ({ accepted: zh ? "agent 已接管" : "agent took over", awaiting_agent: zh ? "等 agent 回应" : "awaiting the agent", intent_received: zh ? "agent 已提交意图" : "intent received", declined: zh ? "agent 这次不买" : "agent declined", needs_evidence: zh ? "agent 要更多证据" : "agent wants evidence", plan_revised: zh ? "agent 修订了计划" : "agent revised the plan", ended: zh ? "agent 结束了任务" : "agent ended the task", no_response: zh ? "agent 没有回应" : "no response" } as Record<string, string>)[state] ?? state;
}

export function turnReasonLabel(reason: AgentTurn["reason"], locale: Locale): string {
  const zh = locale === "zh";
  return ({ observation_changed: zh ? "观察变了" : "observation changed", ready_for_intent: zh ? "条件清空，可以提交意图" : "conditions clear; an intent may be submitted", step_confirmed: zh ? "上一步已确认" : "previous step confirmed", authorized: zh ? "已授权" : "authorized" } as Record<string, string>)[reason] ?? reason;
}

/** 时间线里与决策有关的条目（agent_* / intent_* / conditions_changed），按时间正序 */
export const DECISION_TIMELINE_TYPES = new Set(["agent_turn", "agent_declined", "agent_needs_evidence", "agent_plan_revised", "agent_ended", "agent_no_response", "intent_certified", "intent_simulated", "intent_rejected", "intent_withdrawn", "conditions_changed", "brief_updated", "agent_accepted", "step_confirmed"]);
export function decisionEntries(timeline: TaskTimelineEntry[] | undefined): TaskTimelineEntry[] {
  return (timeline ?? []).filter((e) => DECISION_TIMELINE_TYPES.has(e.type)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}
export function entryLabel(type: string, locale: Locale): string {
  const zh = locale === "zh";
  return ({ agent_turn: zh ? "叫醒 agent" : "agent woken", agent_declined: zh ? "agent 这次不买" : "agent declined", agent_needs_evidence: zh ? "agent 要证据" : "agent wants evidence", agent_plan_revised: zh ? "agent 修订计划" : "agent revised plan", agent_ended: zh ? "agent 结束" : "agent ended", agent_no_response: zh ? "agent 未回应" : "no response", intent_certified: zh ? "意图通过，已签证书" : "intent certified", intent_simulated: zh ? "意图通过（模拟，不签证书）" : "intent passed (simulation, no certificate)", brief_updated: zh ? "简报更新" : "brief updated", agent_accepted: zh ? "agent 接管" : "agent took over", intent_rejected: zh ? "意图被拒" : "intent rejected", intent_withdrawn: zh ? "意图撤回" : "intent withdrawn", step_confirmed: zh ? "成交已上链确认" : "fill confirmed on-chain", conditions_changed: zh ? "计划条件改了（不重签）" : "plan conditions changed (no re-sign)" } as Record<string, string>)[type] ?? type;
}
