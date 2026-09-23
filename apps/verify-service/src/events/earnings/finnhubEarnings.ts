/**
 * Finnhub 财报日历适配（Lane D · C6）。探针 2026-09-23（docs/devday-2026/earnings-source-probe.md）：
 * 免费档 `GET /calendar/earnings?symbol&from&to` 41/41 → 200，无 403；
 * 响应 `{ earningsCalendar: [{ date, hour: "bmo"|"amc"|"dmh"|"", quarter, year, symbol, epsActual, epsEstimate, revenueActual, revenueEstimate }] }`；
 * **没有确认字段**，也不给发布时间 → 事件一律 `estimated`，`firstKnownAt` 取我们首次入库时刻。
 * 只做搬运与时间标注，映射在 mapping.ts。
 */
import { keccak256Utf8, type Bytes32, type EvidenceTime } from "@chaconne/core/verify";

export interface FinnhubEarningsRow {
  date: string;
  /** "bmo" | "amc" | "dmh" | ""（空 = 未知） */
  hour: string;
  quarter: number | null;
  year: number | null;
  symbol: string;
  epsActual: number | null;
  epsEstimate: number | null;
  revenueActual: number | null;
  revenueEstimate: number | null;
}

export interface FinnhubEarningsCall {
  ok: boolean;
  status: number;
  rows: FinnhubEarningsRow[] | null;
  rawHash: Bytes32;
  time: EvidenceTime;
  /** 不含 token */
  endpoint: string;
}

export interface EarningsCalendarSource {
  readonly name: string;
  calendar(symbol: string, from: string, to: string): Promise<FinnhubEarningsCall>;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function parseEarningsCalendar(text: string, status: number): FinnhubEarningsRow[] | null {
  if (status !== 200) return null;
  try {
    const j = JSON.parse(text) as { earningsCalendar?: unknown };
    if (!Array.isArray(j.earningsCalendar)) return null;
    const rows: FinnhubEarningsRow[] = [];
    for (const r of j.earningsCalendar as Array<Record<string, unknown>>) {
      if (typeof r["date"] !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(r["date"])) continue;
      rows.push({
        date: r["date"],
        hour: typeof r["hour"] === "string" ? r["hour"].toLowerCase() : "",
        quarter: num(r["quarter"]),
        year: num(r["year"]),
        symbol: typeof r["symbol"] === "string" ? r["symbol"] : "",
        epsActual: num(r["epsActual"]),
        epsEstimate: num(r["epsEstimate"]),
        revenueActual: num(r["revenueActual"]),
        revenueEstimate: num(r["revenueEstimate"]),
      });
    }
    return rows;
  } catch {
    return null;
  }
}

export class FinnhubEarningsClient implements EarningsCalendarSource {
  readonly name = "finnhub";
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl = "https://finnhub.io/api/v1",
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async calendar(symbol: string, from: string, to: string, timeoutMs = 10_000): Promise<FinnhubEarningsCall> {
    const requestedAt = this.clock().toISOString();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let status = 0;
    let text = "";
    const endpoint = `calendar/earnings?symbol=${symbol}&from=${from}&to=${to}`;
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/calendar/earnings?symbol=${encodeURIComponent(symbol)}&from=${from}&to=${to}`, {
        headers: { "X-Finnhub-Token": this.apiKey },
        signal: ctrl.signal,
      });
      status = res.status;
      text = await res.text();
    } catch (e) {
      text = `fetch_error:${e instanceof Error ? e.name : "unknown"}`;
    } finally {
      clearTimeout(timer);
    }
    const receivedAt = this.clock().toISOString();
    const rows = parseEarningsCalendar(text, status);
    return {
      ok: rows !== null,
      status,
      rows,
      rawHash: keccak256Utf8(text),
      // 源不给发布时间：sourceTimeKind 只能 not_provided（不能把 receivedAt 冒充源时间）
      time: { requestedAt, receivedAt, sourcePublishedAt: null, sourceTimeKind: "not_provided" },
      endpoint,
    };
  }
}
