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
const CROSS: Record<string, { en: string; zh: string }> = {
  relief: { en: "relief", zh: "缓和" },
  transmission: { en: "transmission", zh: "传导" },
  divergence: { en: "divergence", zh: "背离" },
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
      return zh ? `要求跨资产确认（${list(c.acceptStates, CROSS, locale)}）` : `Require cross-asset confirmation (${list(c.acceptStates, CROSS, locale)})`;
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
      // 新的条件类型：不露 JSON / SNAKE_CASE，给一句通用话；原始结构只在开发者视图
      return zh ? "另有一条自定义条件" : "One more custom condition";
  }
}

/**
 * 服务端影响清单里的规则标签（`avoid_event_window(MACRO_TIER1|FED_SPEECH,30,20)`、`earnings_window(2,1)`）→ 条件对象。
 * 标签里没有的字段按「不确定」取保守值（不含估计日期、不整日等待），只用于翻成人话；认不出返回 null。
 */
export function parseRuleLabel(label: string): Condition | null {
  const m = /^\s*([a-z_]+)\s*\(([^)]*)\)\s*$/.exec(label);
  if (!m) return null;
  const args = m[2]!.split(",").map((s) => s.trim());
  const num = (s: string | undefined) => (s !== undefined && /^\d+$/.test(s) ? Number(s) : null);
  if (m[1] === "avoid_event_window" && args.length === 3) {
    const kinds = args[0]!.split("|").filter(Boolean);
    const before = num(args[1]);
    const after = num(args[2]);
    if (!kinds.length || before === null || after === null) return null;
    return { type: "avoid_event_window", kinds: kinds as Extract<Condition, { type: "avoid_event_window" }>["kinds"], beforeMin: before, afterMin: after, includeEstimated: false, wholeDayIfDayPrecision: false };
  }
  if (m[1] === "earnings_window" && args.length === 2) {
    const before = num(args[0]);
    const after = num(args[1]);
    if (before === null || after === null) return null;
    return { type: "earnings_window", beforeTradingDays: before, afterSessions: after, requireRegularSessionAfter: false, requireLiveReferenceAfter: false };
  }
  return null;
}

/** 规则标签 → 人话；认不出时也不露原串 */
export function ruleLabelText(label: string, locale: Locale): string {
  const c = parseRuleLabel(label);
  if (!c) return locale === "zh" ? "一条与事件相关的规则" : "A rule tied to this event";
  if (c.type === "avoid_event_window") {
    return locale === "zh"
      ? `${list(c.kinds, KIND, locale)}前 ${c.beforeMin} 分钟到后 ${c.afterMin} 分钟暂停`
      : `Pause from ${c.beforeMin} min before to ${c.afterMin} min after ${list(c.kinds, KIND, locale)}`;
  }
  return conditionText(c, locale);
}

/** 条件串或条件对象，统一翻成人话（事件台等只拿到字符串的地方用） */
export function conditionLike(v: unknown, locale: Locale): string {
  if (typeof v === "string") return ruleLabelText(v, locale);
  if (v && typeof v === "object" && "type" in v) return conditionText(v as Condition, locale);
  return locale === "zh" ? "一条条件" : "A condition";
}
