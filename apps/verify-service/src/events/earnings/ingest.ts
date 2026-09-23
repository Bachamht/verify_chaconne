/**
 * 财报层摄入（Lane D · C6）：登记表全部 us-equity underlying → Finnhub 日历 → MarketEvent upsert → market_event 证据 → 修订回调。
 * 逐只串行 + 间隔（免费档 60/min）；上游失败只记摄入记录（ok=false），不伪造事件；未覆盖（0 行）→ coverage=unknown。
 */
import { NYSE_CALENDAR, nyPartsOf, type MarketCalendar } from "@chaconne/core";
import type { AssetRegistry, EvidenceRecord, IsoUtc, MarketEventEvidence } from "@chaconne/core/verify";
import { newId } from "../../ids";
import { log } from "../../log";
import type { EarningsCalendarSource } from "./finnhubEarnings";
import { buildEarningsDraft, underlyingSymbol } from "./mapping";
import type { EventStore, EventUpsertResult, EvidenceSink, IngestRun } from "./store";

export interface IngestDeps {
  source: EarningsCalendarSource;
  registry: AssetRegistry;
  store: EventStore;
  evidence: EvidenceSink;
  clock?: () => Date;
  /** 相邻请求间隔（ms） */
  spacingMs?: number;
  horizonDays?: number;
  lookbackDays?: number;
  calendar?: MarketCalendar;
  /** 每次 upsert 后回调（修订传播挂这里） */
  onChange?: (r: EventUpsertResult) => Promise<void>;
}

export interface IngestSummary {
  startedAt: IsoUtc;
  finishedAt: IsoUtc;
  runs: IngestRun[];
  created: number;
  revised: number;
  released: number;
  unchanged: number;
  errors: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const DAY_MS = 86_400_000;

export function etDateOf(d: Date): string {
  const p = nyPartsOf(d);
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export class EarningsIngestor {
  private running = false;
  constructor(private readonly d: IngestDeps) {}

  /** 登记表里的美股 underlying（去重；含 executionAllowed=false 的，事件台仍要显示） */
  underlyings(): Array<{ underlyingId: string; symbol: string }> {
    const seen = new Set<string>();
    const out: Array<{ underlyingId: string; symbol: string }> = [];
    for (const e of this.d.registry.entries) {
      if (e.role !== "stock_output" || !e.underlyingId.startsWith("us-equity:") || seen.has(e.underlyingId)) continue;
      seen.add(e.underlyingId);
      out.push({ underlyingId: e.underlyingId, symbol: underlyingSymbol(e.underlyingId) });
    }
    return out;
  }

  range(now: Date): { from: string; to: string } {
    const lookback = this.d.lookbackDays ?? 7;
    const horizon = this.d.horizonDays ?? 120;
    return { from: etDateOf(new Date(now.getTime() - lookback * DAY_MS)), to: etDateOf(new Date(now.getTime() + horizon * DAY_MS)) };
  }

  async ingestSymbol(u: { underlyingId: string; symbol: string }): Promise<{ run: IngestRun; results: EventUpsertResult[] }> {
    const now = (this.d.clock ?? (() => new Date()))();
    const { from, to } = this.range(now);
    const call = await this.d.source.calendar(u.symbol, from, to);
    const results: EventUpsertResult[] = [];
    const evidenceIds: string[] = [];
    if (call.ok && call.rows) {
      for (const row of call.rows) {
        const draft = buildEarningsDraft(row, u.underlyingId, call.time.receivedAt, this.d.calendar ?? NYSE_CALENDAR);
        const r = await this.d.store.upsert(draft, call.time.receivedAt);
        results.push(r);
        const payload: MarketEventEvidence = {
          kind: "market_event",
          eventId: r.event.id,
          eventKind: r.event.kind,
          revision: r.event.revision,
          status: r.event.status,
          datePrecision: r.event.datePrecision,
          scheduledAtUtc: r.event.scheduledAtUtc,
          dateLocal: r.event.dateLocal,
          firstKnownAt: r.event.firstKnownAt,
        };
        const record: EvidenceRecord = {
          evidenceId: newId("ev"),
          provider: this.d.source.name,
          endpoint: call.endpoint,
          requestFingerprint: `symbol=${u.symbol};from=${from};to=${to};row=${row.date}`,
          time: call.time,
          block: null,
          rawHash: call.rawHash,
          parserVersion: "earnings/1",
          mode: "LIVE",
          payload,
        };
        await this.d.evidence.write(record, { refId: r.event.id, version: r.event.revision });
        evidenceIds.push(record.evidenceId);
        if (this.d.onChange) await this.d.onChange(r);
      }
    }
    const run: IngestRun = {
      id: newId("ev").replace(/^ev_/, "ing_"),
      source: this.d.source.name,
      symbol: u.symbol,
      underlyingId: u.underlyingId,
      httpStatus: call.status,
      ok: call.ok,
      rowCount: call.rows?.length ?? 0,
      rawHash: call.rawHash,
      requestedAt: call.time.requestedAt,
      receivedAt: call.time.receivedAt,
      fromDate: from,
      toDate: to,
      eventIds: results.map((r) => r.event.id),
      evidenceIds,
    };
    await this.d.store.recordIngest(run);
    return { run, results };
  }

  async ingestAll(): Promise<IngestSummary> {
    if (this.running) throw new Error("earnings ingest already running");
    this.running = true;
    const clock = this.d.clock ?? (() => new Date());
    const startedAt = clock().toISOString();
    const summary: IngestSummary = { startedAt, finishedAt: startedAt, runs: [], created: 0, revised: 0, released: 0, unchanged: 0, errors: 0 };
    try {
      const list = this.underlyings();
      for (let i = 0; i < list.length; i++) {
        const t0 = Date.now();
        try {
          const { run, results } = await this.ingestSymbol(list[i]!);
          summary.runs.push(run);
          if (!run.ok) summary.errors++;
          for (const r of results) summary[r.change === "created" ? "created" : r.change === "revised" ? "revised" : r.change === "released" ? "released" : "unchanged"]++;
        } catch (e) {
          summary.errors++;
          log.warn("财报摄入单只失败", { symbol: list[i]!.symbol, error: e instanceof Error ? e.message : String(e) });
        }
        const spacing = this.d.spacingMs ?? 1100;
        const dt = Date.now() - t0;
        if (i < list.length - 1 && dt < spacing) await sleep(spacing - dt);
      }
    } finally {
      this.running = false;
    }
    summary.finishedAt = clock().toISOString();
    log.info("财报摄入完成", { symbols: summary.runs.length, created: summary.created, revised: summary.revised, released: summary.released, errors: summary.errors });
    return summary;
  }

  /** 周期运行；返回停止函数 */
  start(intervalMs: number, initialDelayMs = 15_000): () => void {
    let timer: NodeJS.Timeout | null = null;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      try {
        await this.ingestAll();
      } catch (e) {
        log.warn("财报摄入轮次失败", { error: e instanceof Error ? e.message : String(e) });
      }
      if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
    };
    timer = setTimeout(() => void tick(), initialDelayMs);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }
}
