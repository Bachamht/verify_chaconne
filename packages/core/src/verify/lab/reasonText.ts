/**
 * 原因码 → 阻塞说明文案（中英双语）。只描述**已发生的事实与已知的恢复点**，不生成预测（L-01）：
 * 不写"预计 X 分钟后可买"、不写涨跌判断、不承诺倒计时结束必成交。
 */
import type { ReasonCode } from "../contracts";

export type LabLocale = "en" | "zh";
export interface BiText { en: string; zh: string }

const T: Partial<Record<ReasonCode, BiText>> = {
  /* ---- v6 条件层 ---- */
  CONTEXT_UNAVAILABLE: { en: "Market context is unavailable (no signed snapshot, or signature rejected). Conditions that need it wait.", zh: "市场上下文不可用（没有已验签的快照，或验签被拒）。依赖它的条件等待。" },
  CONTEXT_STALE: { en: "The context field this condition needs is older than its freshness rule allows.", zh: "该条件依赖的上下文字段已超过其时效规则。" },
  CONTEXT_FIELD_NOT_IN_TIER: { en: "The context field this condition needs is not exported at this access tier.", zh: "该条件依赖的上下文字段不在当前档位导出范围内。" },
  EVENT_WINDOW_ACTIVE: { en: "Now is inside the avoidance window of a scheduled event you chose to avoid.", zh: "当前处于你选择回避的事件窗口内。" },
  EVENT_DATE_UNCERTAIN: { en: "An event you avoid has only day precision (no exact time). Choose whole-day waiting or accept the day.", zh: "你回避的事件只有日期精度（没有确切时刻）。请选择整日等待，或接受该日。" },
  EARNINGS_WINDOW_ACTIVE: { en: "Now is inside the earnings window of this asset.", zh: "当前处于该资产的财报窗口内。" },
  EARNINGS_COVERAGE_UNKNOWN: { en: "No earnings calendar coverage for this asset; the earnings window cannot be evaluated.", zh: "该资产没有财报日历覆盖，财报窗口无法判定。" },
  FED_BLACKOUT: { en: "Fed communication blackout is on and you opted to avoid it.", zh: "联储静默期生效，且你选择回避它。" },
  VOL_REGIME_EXCEEDED: { en: "The volatility gauge is above the ceiling you set.", zh: "波动率指标高于你设定的上限。" },
  SESSION_RULE_BLOCK: { en: "The US session is not one of the sessions you allowed.", zh: "当前美股时段不在你允许的时段内。" },
  CROSS_ASSET_UNCONFIRMED: { en: "Cross-asset confirmation after the last data release is not in an accepted state.", zh: "最近一次数据发布后的跨资产确认不在接受状态。" },
  STEP_GAP_NOT_ELAPSED: { en: "The required number of trading days since the last confirmed step has not elapsed.", zh: "距上一步确认还未满你要求的交易日间隔。" },
  DAILY_STEP_CAP_REACHED: { en: "The per-trading-day step cap is reached.", zh: "已达到每交易日步数上限。" },
  PREMIUM_CONDITION_NOT_MET: { en: "On-chain premium versus the reference is above your threshold.", zh: "链上价相对参考价的溢价高于你的阈值。" },
  TARGET_NOT_REACHED: { en: "The live reference price has not reached your target.", zh: "实时参考价未到你的目标价。" },
  TRACKED_COST_UNKNOWN: { en: "Tracked cost covers less than 100% of the position; cost-based conditions cannot be evaluated.", zh: "可追溯成本覆盖率不足 100%，成本类条件无法判定。" },
  CASH_FLOOR_BLOCK: { en: "Executing would take the funding balance below your cash floor.", zh: "执行会让资金余额跌破你的现金下限。" },
  BUDGET_GROUP_CONFLICT: { en: "Another task in the same budget group holds the reservation; this task waits its turn.", zh: "同资金组的另一任务持有预留，本任务排队等待。" },
  BUDGET_GROUP_EXHAUSTED: { en: "The budget group cap for this period is used up.", zh: "资金组本周期额度已用完。" },
  BUDGET_PENDING_OCCUPIED: { en: "In-flight steps occupy the remaining budget until they confirm or revert on-chain.", zh: "在途步骤占用剩余额度，直到链上确认或回滚。" },
  THESIS_INVALIDATED: { en: "A machine premise of the thesis card is invalidated.", zh: "理由卡的某条机器前提已失效。" },
  THESIS_UNKNOWN: { en: "A thesis premise is unknown (research items await your review).", zh: "理由卡有前提状态未知（研究项等待你复核）。" },
  THESIS_EXPIRED: { en: "The thesis card passed its validUntil.", zh: "理由卡已过有效期。" },
  EXECUTOR_OFFLINE: { en: "No executor heartbeat in the last 3 minutes (informational; does not block issuance).", zh: "3 分钟内没有执行器心跳（信息项，不阻塞签发）。" },
  AWAITING_USER_SIGNATURE: { en: "Browser-wallet path: waiting for your signature (informational).", zh: "浏览器钱包路径：等待你签名（信息项）。" },
  INTENT_OUT_OF_SCOPE: { en: "The agent's trade intent is outside the scope you signed.", zh: "agent 的交易意图超出了你签的范围。" },
  DECISION_BASIS_NOT_ADMISSIBLE: { en: "The agent cited a basis your trust tier does not admit.", zh: "agent 引用了你的信任档位不采信的依据。" },
  HARD_CONSTRAINT_BLOCK: { en: "A hard constraint in the signed scope is not satisfied.", zh: "签名里的硬约束未满足。" },
  SELL_MANDATE_REQUIRED: { en: "Selling needs a separate sell authorization for that asset.", zh: "卖出需要按资产另签一份卖出授权。" },
  /* ---- 规划/报价层（对照与回放里会出现） ---- */
  QUOTE_UNAVAILABLE: { en: "No executable quote at this point in time.", zh: "该时点没有可成交报价。" },
  QUOTE_TOO_OLD: { en: "The quote is older than the policy allows.", zh: "报价超过策略允许的时效。" },
  REFERENCE_MISSING: { en: "No stock reference price at this point in time.", zh: "该时点没有股票参考价。" },
  REFERENCE_STALE: { en: "The stock reference price is older than the policy allows.", zh: "股票参考价超过策略允许的时效。" },
  MARKET_OUTSIDE_REGULAR: { en: "US market is outside regular hours.", zh: "美股不在常规时段。" },
  PRICE_IMPACT_EXCEEDED: { en: "Price impact exceeds your limit.", zh: "价格冲击超过你的上限。" },
  REFERENCE_DEVIATION_EXCEEDED: { en: "Executable price deviates from the reference beyond your limit.", zh: "可执行单价相对参考价的偏差超过你的上限。" },
};

/** 恢复点未知时的原因说明（写进 text，不猜时间） */
const UNKNOWN_NEXT: Partial<Record<ReasonCode, BiText>> = {
  CASH_FLOOR_BLOCK: { en: "Next check time is unknown: it depends on your balance changing.", zh: "下次检查点未知：取决于你的余额变化。" },
  BUDGET_GROUP_CONFLICT: { en: "Next check time is unknown: it depends on the other task confirming or releasing on-chain.", zh: "下次检查点未知：取决于另一任务链上确认或释放。" },
  BUDGET_PENDING_OCCUPIED: { en: "Next check time is unknown: it depends on in-flight steps confirming or reverting.", zh: "下次检查点未知：取决于在途步骤确认或回滚。" },
  VOL_REGIME_EXCEEDED: { en: "Next check time is unknown: no one can say when the gauge will fall.", zh: "下次检查点未知：指标何时回落无法预知。" },
  TARGET_NOT_REACHED: { en: "Next check time is unknown: price paths are not predicted here.", zh: "下次检查点未知：这里不预测价格路径。" },
  PREMIUM_CONDITION_NOT_MET: { en: "Next check time is unknown: premium paths are not predicted here.", zh: "下次检查点未知：这里不预测溢价路径。" },
  EVENT_DATE_UNCERTAIN: { en: "Next check time is unknown until you choose how to treat the day-precision event.", zh: "在你决定如何处理该日期精度事件之前，下次检查点未知。" },
  THESIS_UNKNOWN: { en: "Next check time is unknown: it waits for your review.", zh: "下次检查点未知：等待你的复核。" },
  THESIS_INVALIDATED: { en: "Next check time is unknown: a new thesis or a new authorization is needed.", zh: "下次检查点未知：需要新的理由卡或新的授权。" },
  THESIS_EXPIRED: { en: "Next check time is unknown: renew or end the task.", zh: "下次检查点未知：续订或结束任务。" },
  TRACKED_COST_UNKNOWN: { en: "Next check time is unknown: report cost or switch to a target-price rule.", zh: "下次检查点未知：自报成本或改用目标价规则。" },
  CONTEXT_UNAVAILABLE: { en: "Next check time is unknown: it depends on the context feed recovering.", zh: "下次检查点未知：取决于上下文数据源恢复。" },
  CONTEXT_STALE: { en: "Next check time is unknown: it depends on the stale field being refreshed.", zh: "下次检查点未知：取决于过期字段被刷新。" },
  CONTEXT_FIELD_NOT_IN_TIER: { en: "Next check time is unknown: the field is not exported at this tier at all.", zh: "下次检查点未知：该字段在此档位根本不导出。" },
  QUOTE_UNAVAILABLE: { en: "Next check time is unknown: quotes are fetched fresh on each check.", zh: "下次检查点未知：每次检查都会重新取报价。" },
  EARNINGS_COVERAGE_UNKNOWN: { en: "Next check time is unknown: no calendar source covers this asset.", zh: "下次检查点未知：没有日历源覆盖该资产。" },
};
const GENERIC_UNKNOWN: BiText = { en: "Next check time is unknown for this item.", zh: "该项的下次检查点未知。" };

/** 需要用户处理的原因码（不是等一等就会过去的） */
export const USER_ACTION_CODES: ReadonlySet<ReasonCode> = new Set<ReasonCode>([
  "EVENT_DATE_UNCERTAIN",
  "TRACKED_COST_UNKNOWN",
  "CASH_FLOOR_BLOCK",
  "THESIS_UNKNOWN",
  "THESIS_INVALIDATED",
  "THESIS_EXPIRED",
  "AWAITING_USER_SIGNATURE",
  "CONTEXT_FIELD_NOT_IN_TIER",
]);

export function reasonBi(code: ReasonCode): BiText {
  return T[code] ?? { en: code, zh: code };
}
export function labReasonText(code: ReasonCode, locale: LabLocale): string {
  return reasonBi(code)[locale];
}
export function nextCheckUnknownBi(code: ReasonCode): BiText {
  return UNKNOWN_NEXT[code] ?? GENERIC_UNKNOWN;
}
/** 阻塞项完整文案：原因 + （恢复点未知时）为什么未知 */
export function blockerText(code: ReasonCode, nextCheckAt: string | null, locale: LabLocale): string {
  const base = labReasonText(code, locale);
  return nextCheckAt ? base : `${base} ${nextCheckUnknownBi(code)[locale]}`;
}
