/**
 * 原因码 → 说明文案（zh/en）。Blocker.text 与页面文案都从这里映射，不生成预测、不写涨跌。
 * 只覆盖 Lane D 用到的码；其它码回退到码本身（页面再用 lib/reasons.ts 兜底）。
 */
import type { ReasonCode } from "@chaconne/core/verify";

export type Locale = "zh" | "en";

const R: Partial<Record<ReasonCode, { zh: string; en: string }>> = {
  EARNINGS_WINDOW_ACTIVE: { zh: "处于你设定的财报窗口内：财报前后暂停签发，等窗口结束后再评估。", en: "Inside your earnings window: issuance pauses around the report and resumes after the window ends." },
  EVENT_WINDOW_ACTIVE: { zh: "处于你设定的事件窗口内：窗口结束前不签发。", en: "Inside your event window: nothing is issued until the window closes." },
  EVENT_DATE_UNCERTAIN: { zh: "该事件只有日期、没有具体时刻。你没有预选「整日等待」，需要你选择：整日等待，或忽略此事件。服务不会替你补一个时刻。", en: "This event has a date but no time. You have not pre-selected whole-day waiting; choose whole-day wait or ignore. The service will not invent a time." },
  EARNINGS_COVERAGE_UNKNOWN: { zh: "财报日历源未覆盖该资产：不能断言「无财报」，按未知处理。", en: "The earnings calendar source does not cover this asset: treated as unknown, not as \"no earnings\"." },
  REFERENCE_STALE: { zh: "股票参考价尚未恢复为实时（仍是收盘/陈旧值）：财报窗口计时已结束也不买。", en: "The stock reference has not returned to live (still a close/stale value): the window timer ending is not enough to buy." },
  REFERENCE_MISSING: { zh: "没有可用的股票参考价：财报窗口计时已结束也不买。", en: "No stock reference is available: the window timer ending is not enough to buy." },
  PRICE_IMPACT_EXCEEDED: { zh: "链上报价的价格冲击超过你的上限：现在成交会明显吃亏，继续等待。", en: "On-chain price impact exceeds your limit: executing now would be costly, keep waiting." },
  PRICE_IMPACT_UNKNOWN: { zh: "链上报价的价格冲击未知，不当作 0：继续等待。", en: "On-chain price impact is unknown and is not treated as zero: keep waiting." },
  QUOTE_UNAVAILABLE: { zh: "此刻没有可成交的链上报价。", en: "No executable on-chain quote right now." },
  MARKET_OUTSIDE_REGULAR: { zh: "美股不在常规时段。", en: "US market is outside regular hours." },
  CONTEXT_UNAVAILABLE: { zh: "市场上下文不可用。", en: "Market context unavailable." },
};

export function reasonText(code: ReasonCode | string, locale: Locale = "zh"): string {
  return R[code as ReasonCode]?.[locale] ?? code;
}
