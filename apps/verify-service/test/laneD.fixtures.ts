/** Lane D 测试夹具：假财报源、任务/持仓 fixture、宏观事件种子 */
import { keccak256Utf8, type EvmAddress, type MarketEvent } from "@chaconne/core/verify";
import { FIXTURE_OWNER, FIXTURE_STABLE_KEY, FIXTURE_STOCK_KEY } from "@chaconne/core/verify/fixtures";
import type { EarningsCalendarSource, FinnhubEarningsCall, FinnhubEarningsRow } from "../src/events/earnings/finnhubEarnings";
import type { TaskLite } from "../src/impacts/readers";

export const FAKE_UNDERLYING = "us-equity:FAKE";
export const OWNER: EvmAddress = FIXTURE_OWNER;
export const OTHER_OWNER: EvmAddress = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
/** 2026-10-26 周一 10:00 ET（常规时段） */
export const NOW = "2026-10-26T14:00:00.000Z";

export function row(over: Partial<FinnhubEarningsRow> = {}): FinnhubEarningsRow {
  return { date: "2026-10-28", hour: "amc", quarter: 4, year: 2026, symbol: "FAKE", epsActual: null, epsEstimate: 1.2, revenueActual: null, revenueEstimate: 100, ...over };
}

/** 假源：按 symbol 给行；status 可控；记录调用次数 */
export class FakeEarningsSource implements EarningsCalendarSource {
  readonly name = "finnhub";
  calls: string[] = [];
  constructor(
    public rows: Record<string, FinnhubEarningsRow[] | { status: number }>,
    private readonly clock: () => Date,
  ) {}
  async calendar(symbol: string, from: string, to: string): Promise<FinnhubEarningsCall> {
    this.calls.push(symbol);
    const at = this.clock().toISOString();
    const r = this.rows[symbol];
    if (!r || !Array.isArray(r)) {
      const status = r && !Array.isArray(r) ? r.status : 200;
      const text = status === 200 ? JSON.stringify({ earningsCalendar: [] }) : `{"error":"${status}"}`;
      return { ok: status === 200, status, rows: status === 200 ? [] : null, rawHash: keccak256Utf8(text), time: { requestedAt: at, receivedAt: at, sourcePublishedAt: null, sourceTimeKind: "not_provided" }, endpoint: `calendar/earnings?symbol=${symbol}&from=${from}&to=${to}` };
    }
    const text = JSON.stringify({ earningsCalendar: r });
    return { ok: true, status: 200, rows: r, rawHash: keccak256Utf8(text), time: { requestedAt: at, receivedAt: at, sourcePublishedAt: null, sourceTimeKind: "not_provided" }, endpoint: `calendar/earnings?symbol=${symbol}&from=${from}&to=${to}` };
  }
}

export function earningsTask(over: Partial<TaskLite> = {}): TaskLite {
  return {
    id: "task_e1",
    owner: OWNER,
    status: "ACTIVE",
    playbookId: "event_aware_accumulate",
    conditions: { items: [{ type: "session", allow: ["US_REGULAR"] }, { type: "earnings_window", beforeTradingDays: 1, afterSessions: 1, requireRegularSessionAfter: true, requireLiveReferenceAfter: true }] },
    assetKeys: [FIXTURE_STABLE_KEY, FIXTURE_STOCK_KEY],
    mandateIds: ["mnd_1"],
    nextCheckAt: null,
    ...over,
  };
}

export function avoidTask(wholeDay: boolean, over: Partial<TaskLite> = {}): TaskLite {
  return {
    id: wholeDay ? "task_avoid_wholeday" : "task_avoid_choice",
    owner: OWNER,
    status: "ACTIVE",
    playbookId: "session_dca",
    conditions: { items: [{ type: "avoid_event_window", kinds: ["EARNINGS", "MACRO_TIER1"], beforeMin: 30, afterMin: 20, includeEstimated: true, wholeDayIfDayPrecision: wholeDay }] },
    assetKeys: [FIXTURE_STABLE_KEY, FIXTURE_STOCK_KEY],
    mandateIds: [],
    nextCheckAt: null,
    ...over,
  };
}

/** 宏观事件（crowsnest 形态）：2026-10-28 08:30 ET CPI（exact） */
export function macroEvent(over: Partial<MarketEvent> = {}): MarketEvent {
  return {
    id: "crowsnest:MACRO_TIER1:2026-10-28:cpi",
    kind: "MACRO_TIER1",
    name: "CPI (Oct)",
    underlyingIds: [],
    scheduledAtUtc: "2026-10-28T12:30:00.000Z",
    dateLocal: "2026-10-28",
    datePrecision: "exact",
    sessionHint: null,
    status: "confirmed",
    revision: 1,
    source: "crowsnest",
    sourceFetchedAt: NOW,
    firstKnownAt: "2026-10-01T00:00:00.000Z",
    tz: "America/New_York",
    ...over,
  };
}

/** 深扫响应里不得出现的键（E-07：任何动作都不携带执行材料） */
export function forbiddenKeys(v: unknown, path = "", out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x, i) => forbiddenKeys(x, `${path}[${i}]`, out));
  else if (v && typeof v === "object") {
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (/^(calldata|certificate|signature|typedData|txHash|stepCertificate)$/i.test(k)) out.push(`${path}.${k}`);
      forbiddenKeys(x, `${path}.${k}`, out);
    }
  }
  return out;
}
