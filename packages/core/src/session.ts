/**
 * §7.1 美股时段状态机。
 * 一切时间判断走 IANA `America/New_York`（Intl API，含夏令时）——严禁固定 UTC 偏移。
 *
 *   PRE 04:00–09:30 → REGULAR 09:30–16:00 → POST 16:00–20:00 → CLOSED
 *   周末=CLOSED；交易所假日=HOLIDAY；半日市 13:00 收盘（盘后至 17:00，D-008）
 */
import { NYSE_CALENDAR, type MarketCalendar } from "./calendar";
import type { Session } from "./types";

const NY_TIMEZONE = "America/New_York";

let cachedFmt: Intl.DateTimeFormat | null = null;
function nyFormatter(): Intl.DateTimeFormat {
  cachedFmt ??= new Intl.DateTimeFormat("en-US", {
    timeZone: NY_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  return cachedFmt;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

export interface NyParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  /** 0=周日 … 6=周六 */
  weekday: number;
}

export function nyPartsOf(date: Date): NyParts {
  const parts = nyFormatter().formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string => {
    const p = parts.find((x) => x.type === type);
    if (!p) throw new Error(`Intl 缺少 ${type} 部件`);
    return p.value;
  };
  const weekday = WEEKDAY_INDEX[get("weekday")];
  if (weekday === undefined) throw new Error(`未知 weekday: ${get("weekday")}`);
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")) % 24, // 个别 ICU 版本对 h23 的午夜给 "24"
    minute: Number(get("minute")),
    weekday,
  };
}

export interface SessionInfo {
  session: Session;
  /** America/New_York 本地日（YYYY-MM-DD） */
  nyDate: string;
  /** NY 本地当日分钟数（0–1439） */
  nyMinutes: number;
  isHalfDay: boolean;
}

const MIN = (h: number, m: number): number => h * 60 + m;
const PRE_START = MIN(4, 0);
const REGULAR_START = MIN(9, 30);
const REGULAR_END = MIN(16, 0);
const POST_END = MIN(20, 0);
const HALF_DAY_CLOSE = MIN(13, 0);
const HALF_DAY_POST_END = MIN(17, 0);

export function sessionAt(date: Date, cal: MarketCalendar = NYSE_CALENDAR): SessionInfo {
  const p = nyPartsOf(date);
  const nyDate = `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
  const nyMinutes = MIN(p.hour, p.minute);

  if (cal.holidays.has(nyDate)) {
    return { session: "HOLIDAY", nyDate, nyMinutes, isHalfDay: false };
  }
  if (p.weekday === 0 || p.weekday === 6) {
    return { session: "CLOSED", nyDate, nyMinutes, isHalfDay: false };
  }

  const isHalfDay = cal.halfDays.has(nyDate);
  const regularEnd = isHalfDay ? HALF_DAY_CLOSE : REGULAR_END;
  const postEnd = isHalfDay ? HALF_DAY_POST_END : POST_END;

  let session: Session;
  if (nyMinutes >= PRE_START && nyMinutes < REGULAR_START) session = "PRE";
  else if (nyMinutes >= REGULAR_START && nyMinutes < regularEnd) session = "REGULAR";
  else if (nyMinutes >= regularEnd && nyMinutes < postEnd) session = "POST";
  else session = "CLOSED";

  return { session, nyDate, nyMinutes, isHalfDay };
}

/** 交易日判断（非周末且非假日；半日市算交易日） */
export function isTradingDay(nyDate: string, weekday: number, cal: MarketCalendar = NYSE_CALENDAR): boolean {
  return weekday !== 0 && weekday !== 6 && !cal.holidays.has(nyDate);
}

/**
 * 自某交易日收盘以来「本应再捕获到的官方收盘」数（FIX-085）。
 *
 * 用途：参考价陈旧的**绝对**判据。D-065 的判据是相对的（本资产收盘日 < 全站最新收盘日），
 * 只能抓住"单只喂价死掉"；当整条喂价链路一起断供时，全站收盘日一起冻结、相对判据恒为假，
 * 陈旧收盘会被当成新鲜收盘推出失真溢价（2026-08-26 Pyth equity 断供即如此，见 FIX-085）。
 *
 * 计数规则：closeNyDate 之后、截至 now 的交易日，其中"今天"仅在常规时段已收盘后才计入
 * （收盘捕获发生在收盘瞬间）。周末与假日不计——故周日看周五收盘 = 0，长周末后亦为 0。
 */
export function sessionsSinceClose(
  closeNyDate: string,
  now: Date,
  cal: MarketCalendar = NYSE_CALENDAR,
): number {
  const today = sessionAt(now, cal);
  if (closeNyDate >= today.nyDate) return 0;

  const toMs = (nyDate: string): number => {
    const [y, m, d] = nyDate.split("-").map(Number);
    if (!y || !m || !d) return NaN;
    return Date.UTC(y, m - 1, d);
  };
  const from = toMs(closeNyDate);
  const end = toMs(today.nyDate);
  if (Number.isNaN(from) || Number.isNaN(end)) return 0;

  const DAY_MS = 86_400_000;
  const MAX_DAYS = 400; // 迭代上限（异常日期不拖垮本轮）
  let count = 0;
  let steps = 0;
  for (let t = from + DAY_MS; t <= end && steps < MAX_DAYS; t += DAY_MS, steps++) {
    const d = new Date(t);
    const iso = d.toISOString().slice(0, 10);
    if (!isTradingDay(iso, d.getUTCDay(), cal)) continue;
    if (iso === today.nyDate) {
      // 今日：常规时段结束前还没有"今日收盘"可捕获，不算欠账
      const regularEnd = cal.halfDays.has(iso) ? HALF_DAY_CLOSE : REGULAR_END;
      if (today.nyMinutes < regularEnd) continue;
    }
    count++;
  }
  return steps >= MAX_DAYS ? MAX_DAYS : count;
}
