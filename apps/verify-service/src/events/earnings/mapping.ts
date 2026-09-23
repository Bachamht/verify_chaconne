/**
 * Finnhub 财报行 → MarketEvent（interfaces.md §11.2；类型 contracts.ts「v6 增补」）。
 * 时间规则：一切纽约本地 → UTC 的换算走 `nyPartsOf`（Intl，America/New_York，含夏令时），不硬编码偏移。
 *  - id `finnhub:EARNINGS:<首次可知 dateLocal>:<underlying>`；改期不换 id（按 symbol+财年+季度匹配），revision+1
 *  - hour bmo/amc → datePrecision `exact`，scheduledAtUtc 锚定该交易日常规时段边界（开盘 09:30 / 收盘 16:00，半日市 13:00）；
 *    这是**时段锚点**而非新闻稿精确时刻（源不给）；dmh / 空 → `day`，scheduledAtUtc=null
 *  - 源无确认字段 → status `estimated`；epsActual 出现 → `released`
 */
import { NYSE_CALENDAR, nyPartsOf, type MarketCalendar } from "@chaconne/core";
import type { EventDatePrecision, EventSessionHint, EventStatus, IsoUtc, MarketEvent } from "@chaconne/core/verify";
import type { FinnhubEarningsRow } from "./finnhubEarnings";

export const EARNINGS_SOURCE = "finnhub";
export const NY_TZ = "America/New_York";

/** 纽约本地 (dateLocal, hh:mm) → UTC ISO。两轮修正覆盖夏令时切换日。 */
export function nyLocalToUtc(dateLocal: string, hour: number, minute: number): IsoUtc {
  const [y, m, d] = dateLocal.split("-").map(Number) as [number, number, number];
  const wanted = Date.UTC(y, m - 1, d, hour, minute);
  let guess = wanted;
  for (let i = 0; i < 3; i++) {
    const p = nyPartsOf(new Date(guess));
    const seen = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const diff = seen - wanted;
    if (diff === 0) break;
    guess -= diff;
  }
  return new Date(guess).toISOString();
}

/** 常规时段边界（分钟）：与 session.ts 一致；半日市 13:00 收盘 */
export function regularSessionBounds(dateLocal: string, cal: MarketCalendar = NYSE_CALENDAR): { open: IsoUtc; close: IsoUtc } {
  const half = cal.halfDays.has(dateLocal);
  return { open: nyLocalToUtc(dateLocal, 9, 30), close: nyLocalToUtc(dateLocal, half ? 13 : 16, 0) };
}

export function sessionHintOf(hour: string): EventSessionHint {
  const h = hour.trim().toLowerCase();
  return h === "bmo" || h === "amc" || h === "dmh" ? h : null;
}

export function underlyingSymbol(underlyingId: string): string {
  const i = underlyingId.indexOf(":");
  return i >= 0 ? underlyingId.slice(i + 1) : underlyingId;
}

export function earningsEventId(dateLocal: string, symbol: string): string {
  return `${EARNINGS_SOURCE}:EARNINGS:${dateLocal}:${symbol}`;
}

/** 同一财报事件的匹配键：改期后仍指向同一 id */
export function earningsMatchKey(symbol: string, row: Pick<FinnhubEarningsRow, "year" | "quarter" | "date">): string {
  if (row.year !== null && row.quarter !== null) return `${EARNINGS_SOURCE}:${symbol}:${row.year}Q${row.quarter}`;
  // 源缺财年/季度（探针未见）：退化为按日期匹配，改期会被当成新事件——这是数据缺口，不猜
  return `${EARNINGS_SOURCE}:${symbol}:date:${row.date}`;
}

export interface EarningsEventDraft {
  matchKey: string;
  /** 不含 id / revision / firstKnownAt：由 store 在 upsert 时按既有记录决定 */
  fields: Omit<MarketEvent, "id" | "revision" | "firstKnownAt" | "revisedFrom">;
  /** 源里有 actual → 已发布 */
  released: boolean;
}

export function buildEarningsDraft(row: FinnhubEarningsRow, underlyingId: string, fetchedAt: IsoUtc, cal: MarketCalendar = NYSE_CALENDAR): EarningsEventDraft {
  const symbol = underlyingSymbol(underlyingId);
  const hint = sessionHintOf(row.hour);
  let datePrecision: EventDatePrecision = "day";
  let scheduledAtUtc: IsoUtc | null = null;
  if (hint === "bmo" || hint === "amc") {
    datePrecision = "exact";
    const b = regularSessionBounds(row.date, cal);
    scheduledAtUtc = hint === "bmo" ? b.open : b.close;
  }
  const released = row.epsActual !== null;
  const status: EventStatus = released ? "released" : "estimated";
  const period = row.year !== null && row.quarter !== null ? ` FY${row.year} Q${row.quarter}` : "";
  return {
    matchKey: earningsMatchKey(symbol, row),
    released,
    fields: {
      kind: "EARNINGS",
      name: `${symbol} earnings${period}`,
      underlyingIds: [underlyingId],
      scheduledAtUtc,
      dateLocal: row.date,
      datePrecision,
      sessionHint: hint,
      status,
      source: EARNINGS_SOURCE,
      sourceFetchedAt: fetchedAt,
      tz: NY_TZ,
    },
  };
}
