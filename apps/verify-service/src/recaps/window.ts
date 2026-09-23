/**
 * Recap 生成时刻：纽约**实际**收盘（常规 16:00，提前收盘 13:00）+ 45 分钟。
 * 时区一律走 core/session.ts 的 Intl 反解（含夏令时）；这里不硬编码任何布里斯班/UTC 时刻。
 */
import { NYSE_CALENDAR, isTradingDay, nyPartsOf, sessionAt, type MarketCalendar } from "@chaconne/core";

export const RECAP_DELAY_MINUTES = 45;
const REGULAR_CLOSE_MIN = 16 * 60;
const HALF_DAY_CLOSE_MIN = 13 * 60;

function splitDate(nyDate: string): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(nyDate);
  if (!m) throw new Error(`bad nyDate ${nyDate}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** 纽约本地 (YYYY-MM-DD, 当日分钟) → UTC。用 Intl 反复校正（最多 3 轮），跨夏令时切换日也收敛。 */
export function nyLocalToUtc(nyDate: string, minutes: number): Date {
  const [y, mo, d] = splitDate(nyDate);
  const wanted = Date.UTC(y, mo - 1, d, Math.floor(minutes / 60), minutes % 60);
  let guess = wanted;
  for (let i = 0; i < 3; i++) {
    const p = nyPartsOf(new Date(guess));
    const got = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const diff = wanted - got;
    if (diff === 0) break;
    guess += diff;
  }
  return new Date(guess);
}

export function weekdayOf(nyDate: string): number {
  const [y, mo, d] = splitDate(nyDate);
  return new Date(Date.UTC(y, mo - 1, d)).getUTCDay();
}

export interface RecapWindow {
  date: string;
  tradingDay: boolean;
  earlyClose: boolean;
  /** 当日 NY 本地 00:00 与次日 00:00（UTC），用于圈定"本交易日"的事件 */
  dayStartUtc: Date;
  dayEndUtc: Date;
  closeAtUtc: Date | null;
  generateAfterUtc: Date | null;
}

export function recapWindow(nyDate: string, cal: MarketCalendar = NYSE_CALENDAR): RecapWindow {
  const tradingDay = isTradingDay(nyDate, weekdayOf(nyDate), cal);
  const earlyClose = cal.halfDays.has(nyDate);
  const closeMin = earlyClose ? HALF_DAY_CLOSE_MIN : REGULAR_CLOSE_MIN;
  const closeAtUtc = tradingDay ? nyLocalToUtc(nyDate, closeMin) : null;
  return {
    date: nyDate,
    tradingDay,
    earlyClose,
    dayStartUtc: nyLocalToUtc(nyDate, 0),
    dayEndUtc: nyLocalToUtc(nyDate, 24 * 60),
    closeAtUtc,
    generateAfterUtc: closeAtUtc ? new Date(closeAtUtc.getTime() + RECAP_DELAY_MINUTES * 60_000) : null,
  };
}

function shiftDate(nyDate: string, days: number): string {
  const [y, mo, d] = splitDate(nyDate);
  return new Date(Date.UTC(y, mo - 1, d + days)).toISOString().slice(0, 10);
}

/** 截至 now，最近一个已到生成门槛的交易日（最多回看 14 天；日历覆盖不到就返回 null） */
export function latestDueRecapDate(now: Date, cal: MarketCalendar = NYSE_CALENDAR): string | null {
  let d = sessionAt(now, cal).nyDate;
  for (let i = 0; i < 14; i++) {
    const w = recapWindow(d, cal);
    if (w.tradingDay && w.generateAfterUtc && w.generateAfterUtc.getTime() <= now.getTime()) return d;
    d = shiftDate(d, -1);
  }
  return null;
}

/** 上一个交易日（用于"无事件时的标注日期回放任务"） */
export function previousTradingDay(nyDate: string, cal: MarketCalendar = NYSE_CALENDAR): string {
  let d = shiftDate(nyDate, -1);
  for (let i = 0; i < 14; i++) {
    if (isTradingDay(d, weekdayOf(d), cal)) return d;
    d = shiftDate(d, -1);
  }
  return d;
}
