/**
 * 原因码 → 阻塞项（Blocker）：文案由原因码映射，不生成预测；全量返回（K-02）。
 * userActionRequired：只有用户能解开的项（选整日等待、补成本、标记研究前提、续订理由卡、签名）。
 */
import type { Blocker, ConditionEvaluation, ConditionItemResult, IsoUtc, Reason, ReasonCode } from "../contracts";

export const BLOCKER_TEXT: Partial<Record<ReasonCode, string>> = {
  CONTEXT_UNAVAILABLE: "Market context is unavailable (sentinel unreachable, signature invalid or schema rejected); conditions that depend on it wait.",
  CONTEXT_STALE: "A context field this condition depends on is older than its freshness rule; waiting for a fresher snapshot.",
  CONTEXT_FIELD_NOT_IN_TIER: "A context field this condition depends on is not available in the caller's tier.",
  EVENT_WINDOW_ACTIVE: "Inside an event window defined by this task's own parameters; waiting until the window ends.",
  EVENT_DATE_UNCERTAIN: "An event on this date has no exact time; choose whole-day waiting or accept the uncertainty (no time is invented).",
  EARNINGS_WINDOW_ACTIVE: "Inside the earnings window (before the report, or the required sessions after it have not completed).",
  EARNINGS_COVERAGE_UNKNOWN: "No earnings-calendar coverage for this underlying; the window cannot be evaluated.",
  FED_BLACKOUT: "Inside a Fed communications blackout period (user-selected condition; not a market closure).",
  VOL_REGIME_EXCEEDED: "A volatility measure is above the task's limit.",
  SESSION_RULE_BLOCK: "Outside the sessions allowed by this task.",
  CROSS_ASSET_UNCONFIRMED: "Cross-asset state is not one of the accepted confirmed states (undecided is never accepted).",
  STEP_GAP_NOT_ELAPSED: "The required number of trading days since the last confirmed step has not elapsed.",
  DAILY_STEP_CAP_REACHED: "The per-trading-day step cap has been reached (or the group count is unknown).",
  PREMIUM_CONDITION_NOT_MET: "On-chain executable price is above the premium threshold versus the reference.",
  TARGET_NOT_REACHED: "The target price / PnL threshold has not been reached.",
  TRACKED_COST_UNKNOWN: "Cost basis is not fully traceable; cost-based selling is unavailable — use a target price instead.",
  CASH_FLOOR_BLOCK: "Executing this step would breach the cash floor (or the balance is unknown).",
  BUDGET_GROUP_CONFLICT: "Another task holds the budget-group reservation; waiting by priority.",
  BUDGET_GROUP_EXHAUSTED: "The budget group has no remaining allowance this period.",
  BUDGET_PENDING_OCCUPIED: "Pending (unconfirmed) steps occupy the remaining allowance.",
  THESIS_INVALIDATED: "A machine-checked premise of the thesis is invalidated.",
  THESIS_UNKNOWN: "A thesis premise cannot be evaluated yet.",
  THESIS_EXPIRED: "The thesis validity period has ended; renew or end the task.",
  EXECUTOR_OFFLINE: "No executor heartbeat; issuance is not blocked, but nobody will pick the step up.",
  AWAITING_USER_SIGNATURE: "Waiting for the user to sign in the browser wallet.",
  INTENT_OUT_OF_SCOPE: "The trade intent is outside the signed scope (asset, per-step cap, budget, steps, deadline or selling).",
  DECISION_BASIS_NOT_ADMISSIBLE: "The decision record cites a basis the task's trust tier does not admit.",
  HARD_CONSTRAINT_BLOCK: "A signed hard constraint is not satisfied.",
  SELL_MANDATE_REQUIRED: "Selling needs a separate sell authorization for that asset; nothing is issued from this intent.",
  QUOTE_UNAVAILABLE: "No executable quote for this step right now.",
  QUOTE_TOO_OLD: "The quote is older than the policy allows.",
  REFERENCE_MISSING: "No usable reference price for this condition.",
  REFERENCE_STALE: "The reference price is older than the policy allows or from the wrong session.",
  MARKET_OUTSIDE_REGULAR: "Outside the regular session required by the policy.",
  PRICE_IMPACT_EXCEEDED: "Quoted price impact exceeds the task limit.",
  STEP_AWAITING_CONFIRMATION: "The previous step is submitted and waiting for on-chain confirmation.",
};

const USER_ACTION: ReadonlySet<ReasonCode> = new Set<ReasonCode>(["EVENT_DATE_UNCERTAIN", "TRACKED_COST_UNKNOWN", "THESIS_EXPIRED", "CONTEXT_FIELD_NOT_IN_TIER", "AWAITING_USER_SIGNATURE"]);
/** 信息项：不阻塞签发 */
export const INFO_ONLY_CODES: ReadonlySet<ReasonCode> = new Set<ReasonCode>(["EXECUTOR_OFFLINE", "AWAITING_USER_SIGNATURE", "STEP_AWAITING_CONFIRMATION"]);

export function blockerFromReason(r: Reason, evidenceAt: IsoUtc | null, nextCheckAt: IsoUtc | null): Blocker {
  return { code: r.code, evidenceIds: [...r.evidenceIds], evidenceAt, nextCheckAt, userActionRequired: USER_ACTION.has(r.code), text: BLOCKER_TEXT[r.code] ?? r.code };
}

export function blockersFromItems(items: readonly ConditionItemResult[], evidenceAt: IsoUtc | null): Blocker[] {
  const out: Blocker[] = [];
  for (const it of items) {
    if (it.outcome === "SATISFIED") continue;
    for (const r of it.reasons) if (r.severity === "block") out.push(blockerFromReason(r, evidenceAt, it.nextCheckAt));
  }
  return out;
}

export function blockersFromEvaluation(ev: ConditionEvaluation, evidenceAt: IsoUtc | null = null): Blocker[] {
  return blockersFromItems(ev.perItem, evidenceAt);
}

/** 阻塞集合指纹（只看 code + userActionRequired，忽略时间戳），用于「阻塞集合变化才写库/通知」 */
export function blockerSetKey(blockers: readonly Blocker[]): string {
  return [...new Set(blockers.map((b) => `${b.code}${b.userActionRequired ? "!" : ""}`))].sort().join(",");
}
