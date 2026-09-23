/**
 * 事件窗口（Lane D 内部求值，供影响清单与修订传播用；完整条件 DSL 求值归 Lane B）。
 * 规则（interfaces.md §11.4/§11.5）：
 *  - 窗口不由 producer 决定：每条任务按自己的条件参数算
 *  - `avoid_event_window`：exact → [scheduledAt−beforeMin, scheduledAt+afterMin]；
 *    `day` 精度且 wholeDayIfDayPrecision → 整个纽约本地日；未预选 → **需要用户选择**（EVENT_DATE_UNCERTAIN），不补时刻
 *  - `earnings_window`：从财报日前 beforeTradingDays 个交易日的 00:00 ET 起，到财报后第 afterSessions 个常规时段收盘止；
 *    bmo 的"后第 1 个时段"= 当日常规时段；amc / 未知时段 = 下一交易日（未知按保守处理）
 *  - 交易日按 calendar.ts（周末、假日、半日市）
 */
import { isTradingDay, NYSE_CALENDAR, type MarketCalendar } from "@chaconne/core";
import type { Blocker, Condition, IsoUtc, MarketEvent, ReasonCode } from "@chaconne/core/verify";
import { nyLocalToUtc, regularSessionBounds } from "./mapping";
import { reasonText } from "../../impacts/reasonText";

export type EarningsWindowCondition = Extract<Condition, { type: "earnings_window" }>;
export type AvoidEventWindowCondition = Extract<Condition, { type: "avoid_event_window" }>;

const DAY_MS = 86_400_000;
const toMs = (nyDate: string): number => {
  const [y, m, d] = nyDate.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d);
};
const fromMs = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** 向前/向后数 n 个交易日（n=0 → 若当日非交易日则取下一个交易日） */
export function addTradingDays(nyDate: string, n: number, cal: MarketCalendar = NYSE_CALENDAR): string {
  let ms = toMs(nyDate);
  const step = n < 0 ? -1 : 1;
  let left = Math.abs(n);
  const isTd = (x: number) => isTradingDay(fromMs(x), new Date(x).getUTCDay(), cal);
  if (left === 0) {
    while (!isTd(ms)) ms += DAY_MS;
    return fromMs(ms);
  }
  let guard = 0;
  while (left > 0 && guard++ < 400) {
    ms += step * DAY_MS;
    if (isTd(ms)) left--;
  }
  return fromMs(ms);
}

export interface EventWindow {
  startUtc: IsoUtc;
  endUtc: IsoUtc;
  basis: "exact" | "whole_day" | "trading_sessions";
}
export type WindowResult = { ok: true; window: EventWindow } | { ok: false; code: "EVENT_DATE_UNCERTAIN"; userActionRequired: true };

export function avoidEventWindow(ev: MarketEvent, c: AvoidEventWindowCondition): WindowResult {
  if (ev.datePrecision === "exact" && ev.scheduledAtUtc) {
    const t = Date.parse(ev.scheduledAtUtc);
    return { ok: true, window: { startUtc: new Date(t - c.beforeMin * 60_000).toISOString(), endUtc: new Date(t + c.afterMin * 60_000).toISOString(), basis: "exact" } };
  }
  if (c.wholeDayIfDayPrecision) {
    return { ok: true, window: { startUtc: nyLocalToUtc(ev.dateLocal, 0, 0), endUtc: nyLocalToUtc(addCalendarDay(ev.dateLocal), 0, 0), basis: "whole_day" } };
  }
  return { ok: false, code: "EVENT_DATE_UNCERTAIN", userActionRequired: true };
}

function addCalendarDay(nyDate: string): string {
  return fromMs(toMs(nyDate) + DAY_MS);
}

export function earningsWindow(ev: MarketEvent, c: EarningsWindowCondition, cal: MarketCalendar = NYSE_CALENDAR): EventWindow {
  const eventDay = addTradingDays(ev.dateLocal, 0, cal);
  const startDay = addTradingDays(eventDay, -Math.max(0, c.beforeTradingDays), cal);
  // 财报后的第 N 个常规时段：bmo 当日算第 1 个；amc / 未知 → 下一交易日为第 1 个
  const firstAfter = ev.sessionHint === "bmo" ? eventDay : addTradingDays(eventDay, 1, cal);
  const lastDay = addTradingDays(firstAfter, Math.max(0, c.afterSessions - 1), cal);
  return { startUtc: nyLocalToUtc(startDay, 0, 0), endUtc: regularSessionBounds(lastDay, cal).close, basis: "trading_sessions" };
}

export interface RuleMatch {
  condition: Condition;
  ruleLabel: string;
  result: WindowResult;
}

/** 任务条件中与该事件相关的规则（earnings_window 只对 EARNINGS；avoid_event_window 看 kinds 与 includeEstimated） */
export function matchRules(ev: MarketEvent, items: Condition[], cal: MarketCalendar = NYSE_CALENDAR): RuleMatch[] {
  const out: RuleMatch[] = [];
  for (const c of items) {
    if (c.type === "earnings_window" && ev.kind === "EARNINGS") {
      out.push({ condition: c, ruleLabel: `earnings_window(${c.beforeTradingDays},${c.afterSessions})`, result: { ok: true, window: earningsWindow(ev, c, cal) } });
    } else if (c.type === "avoid_event_window" && c.kinds.includes(ev.kind)) {
      if (!c.includeEstimated && (ev.status === "estimated" || ev.datePrecision === "estimate")) continue;
      out.push({ condition: c, ruleLabel: `avoid_event_window(${c.kinds.join("|")},${c.beforeMin},${c.afterMin})`, result: avoidEventWindow(ev, c) });
    }
  }
  return out;
}

export interface RuleEvaluation {
  /** 现在是否在窗口内 */
  active: boolean;
  /** 窗口尚未开始 */
  upcoming: boolean;
  blocker: Blocker | null;
  nextCheckAt: IsoUtc | null;
}

const blocker = (code: ReasonCode, evidenceIds: string[], evidenceAt: IsoUtc | null, nextCheckAt: IsoUtc | null, userActionRequired: boolean): Blocker => ({
  code,
  evidenceIds,
  evidenceAt,
  nextCheckAt,
  userActionRequired,
  text: reasonText(code, "zh"),
});

/** 一条规则对一个事件在 now 的判定：窗口内 → 阻塞（nextCheckAt=窗口结束）；日期不确定且未预选整日 → 阻塞并要求用户选择（不补时刻） */
export function evaluateRule(ev: MarketEvent, m: RuleMatch, nowIso: IsoUtc, evidenceIds: string[] = []): RuleEvaluation {
  const now = Date.parse(nowIso);
  if (!m.result.ok) {
    // 只有事件当天（纽约本地日）才真正阻塞；之前只是提示需要选择
    const dayStart = Date.parse(nyLocalToUtc(ev.dateLocal, 0, 0));
    const dayEnd = dayStart + DAY_MS;
    const active = now >= dayStart && now < dayEnd;
    return { active, upcoming: now < dayStart, blocker: blocker("EVENT_DATE_UNCERTAIN", evidenceIds, ev.sourceFetchedAt, null, true), nextCheckAt: null };
  }
  const { startUtc, endUtc } = m.result.window;
  const s = Date.parse(startUtc);
  const e = Date.parse(endUtc);
  if (now >= s && now < e) {
    const code: ReasonCode = m.condition.type === "earnings_window" ? "EARNINGS_WINDOW_ACTIVE" : "EVENT_WINDOW_ACTIVE";
    return { active: true, upcoming: false, blocker: blocker(code, evidenceIds, ev.sourceFetchedAt, endUtc, false), nextCheckAt: endUtc };
  }
  return { active: false, upcoming: now < s, blocker: null, nextCheckAt: now < s ? startUtc : null };
}
