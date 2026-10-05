/**
 * Finnhub 财报行 → MarketEvent（interfaces.md §11.2；类型 contracts.ts「v6 增补」）。
 * 时间规则：一切纽约本地 → UTC 的换算走 `nyPartsOf`（Intl，America/New_York，含夏令时），不硬编码偏移。
 *  - id `finnhub:EARNINGS:<首次可知 dateLocal>:<underlying>`；改期不换 id（按 symbol+财年+季度匹配），revision+1
 *  - hour bmo/amc → datePrecision `exact`，scheduledAtUtc 锚定该交易日常规时段边界（开盘 09:30 / 收盘 16:00，半日市 13:00）；
 *    这是**时段锚点**而非新闻稿精确时刻（源不给）；dmh / 空 → `day`，scheduledAtUtc=null
 *  - 源无确认字段 → status `estimated`；epsActual 出现 → `released`
 *  - v7（D-06）：epsActual 出现时附 `outcome`——只写源里真有的字段：EPS 实际值（必有）、营收实际值（有才写）；
 *    预估值（epsEstimate / revenueEstimate）有才写成 `expectation`（kind survey = 分析师一致预期），没有就不写，绝不补。
 *    源不给发布时刻 → `publishedAt` 取首次观测到实际值的抓取时刻（上界，不冒充源时间；不参与 outcome 哈希）。
 */
import { NYSE_CALENDAR, nyPartsOf, type MarketCalendar } from "@chaconne/core";
import { DECIMAL_STRING_RE, type EventDatePrecision, type EventOutcome, type EventOutcomeMetric, type EventSessionHint, type EventStatus, type IsoUtc, type MarketEvent } from "@chaconne/core/verify";
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
  /** v7：源里有 epsActual 才有；只含源里真有的字段 */
  outcome?: EventOutcome;
}

/**
 * Finnhub 的 JSON number → 十进制字符串（canon-1 不收浮点）。转不出纯十进制（如 ≥1e21）→ null，该字段不写。
 */
export function decimalFromNumber(n: number | null): string | null {
  if (n === null || !Number.isFinite(n)) return null;
  const s = String(n);
  if (DECIMAL_STRING_RE.test(s)) return s;
  if (Math.abs(n) < 1) {
    const f = n.toFixed(20).replace(/\.?0+$/, "");
    return DECIMAL_STRING_RE.test(f) ? f : null;
  }
  return null;
}

export const EARNINGS_OUTCOME_SOURCE = "finnhub:calendar/earnings";

/** 财报行 → outcome（epsActual 为空 → undefined）。只搬运源字段，不推算、不补预期。 */
export function buildEarningsOutcome(row: FinnhubEarningsRow, fetchedAt: IsoUtc): EventOutcome | undefined {
  const epsActual = decimalFromNumber(row.epsActual);
  if (epsActual === null) return undefined;
  const period = row.year !== null && row.quarter !== null ? `FY${row.year}Q${row.quarter}` : row.date;
  const expectation = (n: number | null, field: string): EventOutcomeMetric["expectation"] | undefined => {
    const v = decimalFromNumber(n);
    return v === null ? undefined : { value: v, kind: "survey", source: `finnhub:${field}`, at: fetchedAt };
  };
  const metrics: EventOutcomeMetric[] = [];
  const epsExp = expectation(row.epsEstimate, "epsEstimate");
  metrics.push({ key: "eps", label: "EPS", actual: epsActual, unit: "usd_per_share", period, ...(epsExp ? { expectation: epsExp } : {}) });
  const revenueActual = decimalFromNumber(row.revenueActual);
  if (revenueActual !== null) {
    const revExp = expectation(row.revenueEstimate, "revenueEstimate");
    metrics.push({ key: "revenue", label: "Revenue", actual: revenueActual, unit: "usd", period, ...(revExp ? { expectation: revExp } : {}) });
  }
  return { metrics, source: EARNINGS_OUTCOME_SOURCE, publishedAt: fetchedAt, fetchedAt, provider: "finnhub" };
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
  const outcome = buildEarningsOutcome(row, fetchedAt);
  const status: EventStatus = released ? "released" : "estimated";
  const period = row.year !== null && row.quarter !== null ? ` FY${row.year} Q${row.quarter}` : "";
  return {
    matchKey: earningsMatchKey(symbol, row),
    released,
    ...(outcome ? { outcome } : {}),
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
