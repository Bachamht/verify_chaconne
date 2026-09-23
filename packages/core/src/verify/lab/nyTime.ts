/**
 * 纽约时间小工具（Lane E 内部）：全部基于 core 的 `sessionAt` / `nyPartsOf`（IANA America/New_York，含夏令时），
 * 不用固定 UTC 偏移。只做"已知恢复点"的计算（下一常规时段开盘、下一交易日），不做任何预测。
 */
import { isTradingDay, nyPartsOf, sessionAt } from "../../session";
import { NYSE_CALENDAR, type MarketCalendar } from "../../calendar";
import type { IsoUtc, SessionLabel } from "../contracts";

const DAY_MS = 86_400_000;

export function nyDateOf(iso: IsoUtc, cal: MarketCalendar = NYSE_CALENDAR): string {
  return sessionAt(new Date(iso), cal).nyDate;
}

export function addNyDays(nyDate: string, n: number): string {
  const [y, m, d] = nyDate.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d) + n * DAY_MS).toISOString().slice(0, 10);
}

export function weekdayOfNyDate(nyDate: string): number {
  const [y, m, d] = nyDate.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** 纽约本地 (date, hh:mm) → UTC ISO；用 -4/-5 两个候选偏移回验 nyPartsOf，避免手写夏令时规则 */
export function etToUtc(nyDate: string, hour: number, minute: number): IsoUtc {
  const [y, m, d] = nyDate.split("-").map(Number) as [number, number, number];
  for (const off of [4, 5]) {
    const cand = new Date(Date.UTC(y, m - 1, d, hour + off, minute));
    const p = nyPartsOf(cand);
    const same = p.year === y && p.month === m && p.day === d && p.hour === hour && p.minute === minute;
    if (same) return cand.toISOString();
  }
  // 夏令时切换当天 02:00–03:00 不存在的时刻：退到 -4（宁可晚不可早）
  return new Date(Date.UTC(y, m - 1, d, hour + 4, minute)).toISOString();
}

export function isNyTradingDay(nyDate: string, cal: MarketCalendar = NYSE_CALENDAR): boolean {
  return isTradingDay(nyDate, weekdayOfNyDate(nyDate), cal);
}

/** 自 nyDate 起（含）向后找第 n 个交易日（n=0 → nyDate 本身若是交易日） */
export function nthTradingDayFrom(nyDate: string, n: number, cal: MarketCalendar = NYSE_CALENDAR): string {
  let d = nyDate;
  let count = isNyTradingDay(d, cal) ? 0 : -1;
  let guard = 0;
  while (count < n && guard++ < 400) {
    d = addNyDays(d, 1);
    if (isNyTradingDay(d, cal)) count++;
  }
  return d;
}

/** (from, to] 之间的交易日数（不含 from 当日，含 to 当日） */
export function tradingDaysBetween(fromNyDate: string, toNyDate: string, cal: MarketCalendar = NYSE_CALENDAR): number {
  if (toNyDate <= fromNyDate) return 0;
  let n = 0;
  let d = fromNyDate;
  let guard = 0;
  while (d < toNyDate && guard++ < 400) {
    d = addNyDays(d, 1);
    if (isNyTradingDay(d, cal)) n++;
  }
  return n;
}

/** 当前时段标签（由日历推导，与 crowsnest session.label 同口径）；休市/假日 → null */
export function sessionLabelAt(iso: IsoUtc, cal: MarketCalendar = NYSE_CALENDAR): SessionLabel | null {
  const s = sessionAt(new Date(iso), cal).session;
  if (s === "REGULAR") return "US_REGULAR";
  if (s === "PRE") return "US_PRE";
  if (s === "POST") return "US_POST";
  return null;
}

const START: Record<"US_PRE" | "US_REGULAR" | "US_POST", (nyDate: string, cal: MarketCalendar) => IsoUtc> = {
  US_PRE: (d) => etToUtc(d, 4, 0),
  US_REGULAR: (d) => etToUtc(d, 9, 30),
  US_POST: (d, cal) => (cal.halfDays.has(d) ? etToUtc(d, 13, 0) : etToUtc(d, 16, 0)),
};

/** 下一次进入任一允许时段的时刻（严格晚于 now；最多向后看 20 天）；找不到 → null */
export function nextAllowedSessionStart(now: IsoUtc, allow: ReadonlyArray<"US_PRE" | "US_REGULAR" | "US_POST">, cal: MarketCalendar = NYSE_CALENDAR): IsoUtc | null {
  if (allow.length === 0) return null;
  const nowMs = Date.parse(now);
  let d = nyDateOf(now, cal);
  for (let i = 0; i < 20; i++) {
    if (isNyTradingDay(d, cal)) {
      const starts = allow.map((a) => START[a](d, cal)).filter((s) => Date.parse(s) > nowMs).sort();
      if (starts[0]) return starts[0];
    }
    d = addNyDays(d, 1);
  }
  return null;
}
