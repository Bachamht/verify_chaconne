/**
 * 活动事件归类（v7 runtimeModel 搬来，v8 activityText 与公开看板共用；v7 那边 re-export，删 v7 时不断）。
 */
import type { ActivityItem } from "./api-v2";

/**
 * 活动类别：公开看板只显示这些类别（不显示自由文本）。时间线 type 的命名由 Lane R 定，这里按前缀 / 关键字宽松归类，
 * 认不出的一律 "other"（显示「其它活动」，绝不把原始 type 或 note 外露到公开看板）。
 */
export const ACTIVITY_CATEGORIES = ["research", "quote", "intent_buy", "intent_sell", "intent_rejected", "certified", "tx_sent", "fill_confirmed", "exec_failed", "recovered", "waiting", "waiting_data", "data_arrived", "plan_revised", "decision", "delegation", "permit", "control", "ended", "other"] as const;
export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number];
export function isCategory(x: string): x is ActivityCategory {
  return (ACTIVITY_CATEGORIES as readonly string[]).includes(x);
}

export function activityCategory(it: Pick<ActivityItem, "type" | "actor" | "data">): ActivityCategory {
  const type = String(it.type ?? "").toLowerCase();
  const d = (it.data ?? {}) as Record<string, unknown>;
  const given = typeof d["category"] === "string" ? String(d["category"]) : "";
  if (given && isCategory(given)) return given;
  const jobState = /^job_([a-z]+)$/i.exec(type)?.[1];
  const state = String(d["state"] ?? d["status"] ?? jobState ?? "").toUpperCase();
  const tool = String(d["tool"] ?? "");
  if (/quote/.test(type) || tool === "get_executable_quotes") return "quote";
  if (/(tool|run\.started|run_started|turn\.opened|turn_opened|agent_turn|research)/.test(type)) return "research";
  if (type === "run_completed") return "decision";
  if (type === "agent_needs_evidence") return "waiting_data";
  if (type === "agent_ended") return "ended";
  if (type === "handover" || type === "brief_updated") return "control";
  if (/recertif|recovered|reconcil/.test(type)) return "recovered";
  if (/intent/.test(type)) {
    if (/reject|failed/.test(type) || state === "REJECTED") return "intent_rejected";
    if (/certif|step_prepared/.test(type)) return "certified";
    return String(d["side"] ?? d["kind"] ?? "") === "sell" ? "intent_sell" : "intent_buy";
  }
  if (/step_confirmed|sell_confirmed|fill|receipt_confirmed/.test(type) || (/job|execution/.test(type) && state === "CONFIRMED")) return "fill_confirmed";
  if (/job|execution|step_submitted|sent/.test(type)) {
    if (["FAILED", "REVERTED", "EXPIRED"].includes(state) || /fail|revert|expire/.test(type)) return "exec_failed";
    return "tx_sent";
  }
  if (/data_arrived/.test(type)) return "data_arrived";
  if (/permit|allowance/.test(type)) return "permit";
  if (/delegation|authoriz|mandate/.test(type)) return "delegation";
  if (/pause|resume|cancel|revoke/.test(type)) return "control";
  if (/agent.?status|status/.test(type)) {
    const st = String(d["status"] ?? "").toLowerCase();
    if (st === "ended") return "ended";
    if (st === "plan_revised" || /plan/.test(type)) return "plan_revised";
    if (d["waitingData"] === true || st === "needs_evidence" || /data|evidence/.test(st)) return "waiting_data";
    if (st === "waiting" || st === "declined" || st === "hold") return "waiting";
    return "decision";
  }
  if (/plan/.test(type)) return "plan_revised";
  if (/wait/.test(type)) return "waiting";
  return "other";
}

