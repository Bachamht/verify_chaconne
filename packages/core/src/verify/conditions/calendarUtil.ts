/**
 * 交易日 / 时段工具（条件层专用；全部基于 `session.ts` 的 America/New_York 日历，含夏令时、假日、半日市）。
 * 纯函数：时间由调用方传入（毫秒 / ISO），不读系统时钟。
 */
import { NYSE_CALENDAR, type MarketCalendar } from "../../calendar";
import { isTradingDay, nyPartsOf, sessionAt } from "../../session";

const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, "0");

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function zonedFormatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    fmtCache.set(tz, f);
  }
  return f;
}
export function zonedParts(tz: string, ms: number): { date: string; minutes: number } {
  const parts = zonedFormatter(tz).formatToParts(new Date(ms));
  const get = (t: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === t)?.value ?? "0";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, minutes: (Number(get("hour")) % 24) * 60 + Number(get("minute")) };
}

/** YYYY-MM-DD → 该日 00:00 UTC 毫秒（只用于日期差计算） */
export function dateToUtcMs(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) throw new Error(`非法日期: ${date}`);
  return Date.UTC(y, m - 1, d);
}
export function utcMsToDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
/** b − a（天） */
export function daysBetween(a: string, b: string): number {
  return Math.round((dateToUtcMs(b) - dateToUtcMs(a)) / DAY_MS);
}

/** IANA 时区当地 (date, minutes) → UTC 毫秒；迭代修正夏令时偏移 */
export function zonedLocalToUtcMs(tz: string, date: string, minutes: number): number {
  let guess = dateToUtcMs(date) + minutes * 60_000;
  for (let i = 0; i < 3; i++) {
    const got = zonedParts(tz, guess);
    const diff = daysBetween(date, got.date) * 1440 + got.minutes - minutes;
    if (diff === 0) return guess;
    guess -= diff * 60_000;
  }
  return guess;
}
/** 当地整日 [00:00, 24:00) 的 UTC 毫秒区间 */
export function zonedDayBoundsUtcMs(tz: string, date: string): { startMs: number; endMs: number } {
  const startMs = zonedLocalToUtcMs(tz, date, 0);
  const next = utcMsToDate(dateToUtcMs(date) + DAY_MS);
  return { startMs, endMs: zonedLocalToUtcMs(tz, next, 0) };
}

export const NY_TZ = "America/New_York";
export const REGULAR_OPEN_MIN = 9 * 60 + 30;
export const REGULAR_CLOSE_MIN = 16 * 60;
export const HALF_DAY_CLOSE_MIN = 13 * 60;

export function nyDateAt(ms: number): string {
  const p = nyPartsOf(new Date(ms));
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}
export function isNyTradingDate(date: string, cal: MarketCalendar = NYSE_CALENDAR): boolean {
  return isTradingDay(date, new Date(dateToUtcMs(date)).getUTCDay(), cal);
}
/** 从 date（含/不含）起的下一个交易日 */
export function nextTradingDay(date: string, inclusive = false, cal: MarketCalendar = NYSE_CALENDAR): string {
  let ms = dateToUtcMs(date) + (inclusive ? 0 : DAY_MS);
  for (let i = 0; i < 400; i++, ms += DAY_MS) {
    const d = utcMsToDate(ms);
    if (isNyTradingDate(d, cal)) return d;
  }
  throw new Error("日历覆盖不足：找不到下一个交易日");
}
/** date 之后第 n 个交易日（n ≥ 1） */
export function addTradingDays(date: string, n: number, cal: MarketCalendar = NYSE_CALENDAR): string {
  let d = date;
  for (let i = 0; i < n; i++) d = nextTradingDay(d, false, cal);
  return d;
}
/** (from, to] 内的交易日数 */
export function tradingDaysBetweenDates(from: string, to: string, cal: MarketCalendar = NYSE_CALENDAR): number {
  if (to <= from) return 0;
  let n = 0;
  for (let ms = dateToUtcMs(from) + DAY_MS; ms <= dateToUtcMs(to); ms += DAY_MS) if (isNyTradingDate(utcMsToDate(ms), cal)) n++;
  return n;
}
export function regularOpenMs(date: string): number {
  return zonedLocalToUtcMs(NY_TZ, date, REGULAR_OPEN_MIN);
}
export function regularCloseMs(date: string, cal: MarketCalendar = NYSE_CALENDAR): number {
  return zonedLocalToUtcMs(NY_TZ, date, cal.halfDays.has(date) ? HALF_DAY_CLOSE_MIN : REGULAR_CLOSE_MIN);
}
/** 下一次常规时段开盘（严格晚于 now） */
export function nextRegularOpenMs(nowMs: number, cal: MarketCalendar = NYSE_CALENDAR): number {
  const today = nyDateAt(nowMs);
  if (isNyTradingDate(today, cal) && nowMs < regularOpenMs(today)) return regularOpenMs(today);
  return regularOpenMs(nextTradingDay(today, false, cal));
}
/** 下一次常规时段结束（若此刻在常规时段内 = 今日收盘；否则下一交易日收盘） */
export function nextRegularCloseMs(nowMs: number, cal: MarketCalendar = NYSE_CALENDAR): number {
  const today = nyDateAt(nowMs);
  if (isNyTradingDate(today, cal) && nowMs < regularCloseMs(today, cal)) return regularCloseMs(today, cal);
  return regularCloseMs(nextTradingDay(today, false, cal), cal);
}
/** 从 fromMs 起（不含 fromMs 所在的那一段）已完成的常规时段数 */
export function regularSessionsCompletedSince(fromMs: number, nowMs: number, cal: MarketCalendar = NYSE_CALENDAR): number {
  let n = 0;
  let d = nyDateAt(fromMs);
  for (let i = 0; i < 400; i++) {
    if (isNyTradingDate(d, cal)) {
      const close = regularCloseMs(d, cal);
      if (close > fromMs && close <= nowMs) n++;
      if (close > nowMs) break;
    }
    d = utcMsToDate(dateToUtcMs(d) + DAY_MS);
    if (dateToUtcMs(d) > nowMs + DAY_MS) break;
  }
  return n;
}
/** 最近一个已完成常规时段的交易日（今天收盘后 = 今天） */
export function lastCompletedTradingDate(nowMs: number, cal: MarketCalendar = NYSE_CALENDAR): string {
  const today = nyDateAt(nowMs);
  if (isNyTradingDate(today, cal) && nowMs >= regularCloseMs(today, cal)) return today;
  let ms = dateToUtcMs(today) - DAY_MS;
  for (let i = 0; i < 400; i++, ms -= DAY_MS) {
    const d = utcMsToDate(ms);
    if (isNyTradingDate(d, cal)) return d;
  }
  throw new Error("日历覆盖不足");
}
export function sessionLabelAtMs(nowMs: number, cal: MarketCalendar = NYSE_CALENDAR): "US_PRE" | "US_REGULAR" | "US_POST" | "CLOSED" {
  const s = sessionAt(new Date(nowMs), cal).session;
  return s === "REGULAR" ? "US_REGULAR" : s === "PRE" ? "US_PRE" : s === "POST" ? "US_POST" : "CLOSED";
}
