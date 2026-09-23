/**
 * ImpactsService（C6）：`impacts(owner, horizonHours)` → 事件台响应（契约 EventImpact[] + 页面视图 + 覆盖 + 公司行动接入状态）。
 * 数据取不到就标 unavailable，不用回放伪装实时；未覆盖资产 → EARNINGS_COVERAGE_UNKNOWN（E-03）。
 */
import { NYSE_CALENDAR, type MarketCalendar } from "@chaconne/core";
import type { AssetRegistry, EventImpact, IsoUtc } from "@chaconne/core/verify";
import type { CoverageState, EventStore } from "../events/earnings/store";
import { computeImpacts, type EventDeskItem } from "./impacts";
import type { HoldingsReader, TasksReader } from "./readers";

export interface AssetCoverageView {
  assetKey: string;
  displaySymbol: string;
  underlyingId: string;
  executionAllowed: boolean;
  coverage: CoverageState;
  code: "EARNINGS_COVERAGE_UNKNOWN" | null;
  lastProbedAt: IsoUtc | null;
  /** v5 乘数证据的登记基准（1 代币对应股数）；公司行动源未接入时只展示这个 */
  sharesPerToken: string | null;
}

export interface ImpactsResponse {
  owner: string;
  horizonHours: number;
  generatedAt: IsoUtc;
  holdings: { status: "ok" | "unavailable"; note: string | null; asOf: IsoUtc | null; count: number };
  tasks: { status: "ok" | "unavailable"; note: string | null; count: number };
  /** 契约形态（§11.5） */
  impacts: EventImpact[];
  /** 页面视图（含事件本体、规则、阻塞、相关性） */
  items: EventDeskItem[];
  coverage: AssetCoverageView[];
  /** 公司行动（拆股/分红/停牌）：未接入 → not_connected；**不显示"未发生"** */
  corporateActions: { status: "not_connected"; note: string };
}

export interface ImpactsDeps {
  store: EventStore;
  registry: AssetRegistry;
  holdings: HoldingsReader;
  tasks: TasksReader;
  clock?: () => Date;
  calendar?: MarketCalendar;
}

export const MAX_HORIZON_HOURS = 24 * 120;

export class ImpactsService {
  constructor(private readonly d: ImpactsDeps) {}

  async impacts(owner: string, horizonHours = 48): Promise<ImpactsResponse> {
    const ownerLc = owner.toLowerCase();
    const horizon = Math.min(Math.max(1, Math.floor(horizonHours)), MAX_HORIZON_HOURS);
    const now = (this.d.clock ?? (() => new Date()))();
    const nowIso = now.toISOString();
    const [holdings, tasks, events] = await Promise.all([this.d.holdings.holdings(ownerLc), this.d.tasks.tasksOf(ownerLc), this.d.store.list({})]);
    const items = computeImpacts({ owner: ownerLc, nowIso, horizonHours: horizon, events, registry: this.d.registry, holdings, tasks, calendar: this.d.calendar ?? NYSE_CALENDAR });
    const stocks = this.d.registry.entries.filter((e) => e.role === "stock_output");
    const cov = await this.d.store.coverage([...new Set(stocks.map((e) => e.underlyingId))]);
    const covBy = new Map(cov.map((c) => [c.underlyingId, c]));
    const coverage: AssetCoverageView[] = stocks.map((e) => {
      const c = covBy.get(e.underlyingId);
      const state: CoverageState = c?.state ?? "not_probed";
      return { assetKey: e.assetKey, displaySymbol: e.displaySymbol, underlyingId: e.underlyingId, executionAllowed: e.executionAllowed, coverage: state, code: state === "covered" ? null : "EARNINGS_COVERAGE_UNKNOWN", lastProbedAt: c?.lastProbedAt ?? null, sharesPerToken: e.sharesPerToken };
    });
    return {
      owner: ownerLc,
      horizonHours: horizon,
      generatedAt: nowIso,
      holdings: { status: holdings.status, note: holdings.note ?? null, asOf: holdings.asOf ?? null, count: holdings.items.length },
      tasks: { status: tasks.status, note: tasks.note ?? null, count: tasks.items.length },
      impacts: items.map((i) => i.impact),
      items,
      coverage,
      corporateActions: { status: "not_connected", note: "CORPORATE_ACTION_FEED_NOT_CONNECTED" },
    };
  }
}
