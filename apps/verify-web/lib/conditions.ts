/** 条件项 → 人话短句（V-46）：界面不再直接显示条件 JSON；原始结构留给开发者视图。 */
import type { Condition } from "@chaconne/core/verify";
import type { Locale } from "./i18n";

const SESSION: Record<string, { en: string; zh: string }> = {
  US_REGULAR: { en: "US regular hours", zh: "美股常规时段" },
  US_PRE: { en: "US pre-market", zh: "美股盘前" },
  US_POST: { en: "US after-hours", zh: "美股盘后" },
};
const KIND: Record<string, { en: string; zh: string }> = {
  MACRO_TIER1: { en: "tier-1 macro releases", zh: "一级宏观数据" },
  MACRO_TIER2: { en: "tier-2 macro releases", zh: "二级宏观数据" },
  FED_SPEECH: { en: "Fed speeches", zh: "联储讲话" },
  FED_BLACKOUT: { en: "Fed blackout", zh: "联储静默期" },
  EARNINGS: { en: "earnings", zh: "财报" },
  CORPORATE_ACTION: { en: "corporate actions", zh: "公司行动" },
  MARKET_HOLIDAY: { en: "market holidays", zh: "休市日" },
  EARLY_CLOSE: { en: "early closes", zh: "提前收盘" },
};
const REF: Record<string, { en: string; zh: string }> = {
  live: { en: "the live reference", zh: "实时参考价" },
  official_close: { en: "the official close", zh: "正式收盘价" },
  close_last_tick: { en: "the last-tick close", zh: "最后成交收盘价" },
};
const list = (xs: string[], m: Record<string, { en: string; zh: string }>, l: Locale) => xs.map((x) => m[x]?.[l] ?? x).join(l === "zh" ? "、" : ", ");

export function conditionText(c: Condition, locale: Locale): string {
  const zh = locale === "zh";
  switch (c.type) {
    case "session":
      return zh ? `只在${list(c.allow, SESSION, locale)}买` : `Only during ${list(c.allow, SESSION, locale)}`;
    case "avoid_event_window":
      return zh
        ? `避开${list(c.kinds, KIND, locale)}前 ${c.beforeMin} / 后 ${c.afterMin} 分钟${c.includeEstimated ? "（含估计日期）" : ""}${c.wholeDayIfDayPrecision ? "，只有日期时整日等待" : ""}`
        : `Avoid ${c.beforeMin} min before / ${c.afterMin} min after ${list(c.kinds, KIND, locale)}${c.includeEstimated ? " (estimated dates included)" : ""}${c.wholeDayIfDayPrecision ? "; wait the whole day when only a date is known" : ""}`;
    case "earnings_window":
      return zh
        ? `财报前 ${c.beforeTradingDays} 个交易日、后 ${c.afterSessions} 个时段内等待${c.requireLiveReferenceAfter ? "，之后要求实时参考价" : ""}`
        : `Wait ${c.beforeTradingDays} trading day(s) before and ${c.afterSessions} session(s) after earnings${c.requireLiveReferenceAfter ? ", then require a live reference" : ""}`;
    case "not_in_fed_blackout":
      return zh ? "不在联储静默期" : "Not during the Fed blackout";
    case "max_vix":
      return zh ? `VIX 不高于 ${c.value}` : `VIX at or below ${c.value}`;
    case "max_move":
      return zh ? `MOVE 不高于 ${c.value}` : `MOVE at or below ${c.value}`;
    case "premium_bps_lte":
      return zh ? `链上价相对${REF[c.referenceKind]?.zh ?? c.referenceKind}的溢价不超过 ${c.value} bps` : `On-chain premium vs ${REF[c.referenceKind]?.en ?? c.referenceKind} at most ${c.value} bps`;
    case "min_gap_trading_days":
      return zh ? `两步至少隔 ${c.days} 个交易日` : `At least ${c.days} trading day(s) between steps`;
    case "max_steps_per_trading_day":
      return zh ? `每个交易日最多 ${c.value} 步（按${c.scope === "task" ? "本任务" : "资金组"}计）` : `At most ${c.value} step(s) per trading day (per ${c.scope === "task" ? "task" : "budget group"})`;
    case "require_cross_asset_confirmation":
      return zh ? `要求跨资产确认（${c.acceptStates.join("/")}）` : `Require cross-asset confirmation (${c.acceptStates.join("/")})`;
    case "target_price_gte":
      return zh ? `实时股价不低于 $${c.underlyingPriceUsd}` : `Live price at or above $${c.underlyingPriceUsd}`;
    case "target_price_lte":
      return zh ? `实时股价不高于 $${c.underlyingPriceUsd}` : `Live price at or below $${c.underlyingPriceUsd}`;
    case "tracked_cost_pnl_pct_gte":
      return zh ? `相对已追溯成本的盈亏不低于 ${c.value}%` : `P&L vs traced cost at least ${c.value}%`;
    case "cash_floor":
      return zh ? `保留现金下限（最小单位 ${c.floorRaw}）` : `Keep a cash floor (${c.floorRaw} raw units)`;
    case "thesis_holds":
      return zh ? "理由卡的前提仍成立" : "The thesis premises still hold";
    default:
      return JSON.stringify(c);
  }
}
