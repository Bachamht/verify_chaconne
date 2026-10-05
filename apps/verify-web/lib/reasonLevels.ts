/**
 * 阻塞 / 拒绝原因的等级（Blockers 用）：
 *  - wait：按设计在等（时段、目标价、间隔），不是问题
 *  - warn：需要你决定或签名
 *  - block：被硬性条件拦住（数据缺失、超范围）
 * 文案仍在 lib/reasons.ts；这里只管等级，未列出的按 block。
 */
export type ReasonLevel = "wait" | "warn" | "block";

const WAIT = new Set([
  "MARKET_OUTSIDE_REGULAR", "SESSION_RULE_BLOCK", "TARGET_NOT_REACHED", "STEP_GAP_NOT_ELAPSED", "DAILY_STEP_CAP_REACHED",
  "EVENT_WINDOW_ACTIVE", "EARNINGS_WINDOW_ACTIVE", "FED_BLACKOUT", "PREMIUM_CONDITION_NOT_MET", "CROSS_ASSET_UNCONFIRMED",
  "STEP_AWAITING_CONFIRMATION", "BUDGET_PENDING_OCCUPIED", "BUDGET_GROUP_CONFLICT", "CONTEXT_STALE", "VOL_REGIME_EXCEEDED",
  "COMPARISON_NOT_REQUESTED", "CLOSE_CROSS_VERIFIED", "CLOSE_UNCONFIRMED",
]);
const WARN = new Set([
  "AWAITING_USER_SIGNATURE", "SELL_MANDATE_REQUIRED", "THESIS_INVALIDATED", "THESIS_EXPIRED", "EVENT_DATE_UNCERTAIN",
  "EXECUTOR_OFFLINE", "UNIT_CHANGED", "BUDGET_GROUP_EXHAUSTED", "CASH_FLOOR_BLOCK",
]);
/** 需要用户本人动作的 */
const NEEDS_YOU = new Set(["AWAITING_USER_SIGNATURE", "SELL_MANDATE_REQUIRED", "THESIS_INVALIDATED", "THESIS_EXPIRED", "EVENT_DATE_UNCERTAIN"]);

export function reasonLevel(code: string): ReasonLevel {
  if (WAIT.has(code)) return "wait";
  if (WARN.has(code)) return "warn";
  return "block";
}

export function reasonNeedsYou(code: string): boolean {
  return NEEDS_YOU.has(code);
}
