/**
 * 事件存储（Lane D）：MemoryEventStore（测试 / AGENT_C6_STORE=memory 本地演示）与 DrizzleEventStore（verify_events 等，迁移 0018 后）。
 * 修订规则（§11.2）：改期不换 id、revision+1、revisedFrom 保留旧日期；firstKnownAt 取首次入库时刻（源不提供）；
 * 修订历史入 verify_event_revisions；只有 sourceFetchedAt 变化不算修订。
 */
import { and, desc, eq, gte, inArray, lte } from "drizzle-orm";
import { verifyEarningsIngests, verifyEarningsPeriods, verifyEventRevisions, verifyEvents, verifyEvidence, type Db } from "@chaconne/db";
import type { EventKind, EvidenceRecord, IsoUtc, MarketEvent } from "@chaconne/core/verify";
import { earningsEventId, underlyingSymbol, type EarningsEventDraft } from "./mapping";

export type EventChange = "created" | "revised" | "released" | "unchanged";
export interface EventUpsertResult {
  event: MarketEvent;
  change: EventChange;
  changedFields: string[];
  previous: MarketEvent | null;
}
export interface EventRevisionRow {
  revision: number;
  event: MarketEvent;
  changedFields: string[];
  changedAt: IsoUtc;
}
export interface EventListFilter {
  kinds?: EventKind[];
  underlyingIds?: string[];
  /** dateLocal 闭区间 */
  fromDate?: string;
  toDate?: string;
}
export interface IngestRun {
  id: string;
  source: string;
  symbol: string;
  underlyingId: string;
  httpStatus: number;
  ok: boolean;
  rowCount: number;
  rawHash: string;
  requestedAt: IsoUtc;
  receivedAt: IsoUtc;
  fromDate: string;
  toDate: string;
  eventIds: string[];
  evidenceIds: string[];
}
export type CoverageState = "covered" | "unknown" | "unavailable" | "not_probed";
export interface Coverage {
  underlyingId: string;
  state: CoverageState;
  lastProbedAt: IsoUtc | null;
  eventIds: string[];
}

export interface EventStore {
  get(id: string): Promise<MarketEvent | null>;
  list(filter?: EventListFilter): Promise<MarketEvent[]>;
  revisions(id: string): Promise<EventRevisionRow[]>;
  /** 按匹配键 upsert（创建 / 修订 / 已发布 / 不变） */
  upsert(draft: EarningsEventDraft, receivedAt: IsoUtc): Promise<EventUpsertResult>;
  recordIngest(run: IngestRun): Promise<void>;
  /** 每个 underlying 最近一次摄入 → 覆盖判定 */
  coverage(underlyingIds: string[]): Promise<Coverage[]>;
}

export interface EvidenceSink {
  write(record: EvidenceRecord, ref: { refId: string; version: number }): Promise<void>;
  /** 某事件的证据（view_evidence 动作用） */
  forRef(refId: string): Promise<EvidenceRecord[]>;
}

const REVISION_FIELDS = ["dateLocal", "scheduledAtUtc", "sessionHint", "datePrecision"] as const;

/** 纯函数：既有事件 + 新草稿 → 新事件与变化类型 */
export function applyDraft(existing: MarketEvent | null, draft: EarningsEventDraft, receivedAt: IsoUtc): EventUpsertResult {
  const symbol = underlyingSymbol(draft.fields.underlyingIds[0] ?? "");
  if (!existing) {
    const event: MarketEvent = { id: earningsEventId(draft.fields.dateLocal, symbol), ...draft.fields, revision: 1, firstKnownAt: receivedAt, ...(draft.released ? { releasedAt: receivedAt } : {}) };
    return { event, change: "created", changedFields: [], previous: null };
  }
  const changed = REVISION_FIELDS.filter((f) => existing[f] !== draft.fields[f]);
  const nowReleased = draft.released && existing.status !== "released";
  if (changed.length === 0 && !nowReleased) {
    return { event: { ...existing, sourceFetchedAt: receivedAt }, change: "unchanged", changedFields: [], previous: existing };
  }
  const event: MarketEvent = {
    ...existing,
    ...draft.fields,
    id: existing.id,
    revision: existing.revision + 1,
    firstKnownAt: existing.firstKnownAt,
    revisedFrom: changed.length > 0 ? { scheduledAtUtc: existing.scheduledAtUtc, dateLocal: existing.dateLocal } : existing.revisedFrom,
    status: draft.released || existing.status === "released" ? "released" : changed.length > 0 ? "revised" : existing.status,
    ...(existing.releasedAt ? { releasedAt: existing.releasedAt } : nowReleased ? { releasedAt: receivedAt } : {}),
  };
  const changedFields = [...changed, ...(nowReleased ? ["status"] : [])];
  return { event, change: changed.length > 0 ? "revised" : "released", changedFields, previous: existing };
}

function matchesFilter(e: MarketEvent, f: EventListFilter): boolean {
  if (f.kinds && !f.kinds.includes(e.kind)) return false;
  if (f.underlyingIds && !e.underlyingIds.some((u) => f.underlyingIds!.includes(u))) return false;
  if (f.fromDate && e.dateLocal < f.fromDate) return false;
  if (f.toDate && e.dateLocal > f.toDate) return false;
  return true;
}

export function coverageFromRun(underlyingId: string, run: IngestRun | undefined): Coverage {
  if (!run) return { underlyingId, state: "not_probed", lastProbedAt: null, eventIds: [] };
  return { underlyingId, state: !run.ok ? "unavailable" : run.rowCount === 0 ? "unknown" : "covered", lastProbedAt: run.receivedAt, eventIds: run.eventIds };
}

/* ---------------- 内存实现 ---------------- */

export class MemoryEventStore implements EventStore {
  private events = new Map<string, MarketEvent>();
  private byKey = new Map<string, string>();
  private revs = new Map<string, EventRevisionRow[]>();
  private runs = new Map<string, IngestRun>();

  async get(id: string): Promise<MarketEvent | null> {
    return this.events.get(id) ?? null;
  }
  async list(filter: EventListFilter = {}): Promise<MarketEvent[]> {
    return [...this.events.values()].filter((e) => matchesFilter(e, filter)).sort((a, b) => a.dateLocal.localeCompare(b.dateLocal) || a.id.localeCompare(b.id));
  }
  async revisions(id: string): Promise<EventRevisionRow[]> {
    return [...(this.revs.get(id) ?? [])];
  }
  async upsert(draft: EarningsEventDraft, receivedAt: IsoUtc): Promise<EventUpsertResult> {
    const existingId = this.byKey.get(draft.matchKey);
    const existing = existingId ? (this.events.get(existingId) ?? null) : null;
    const r = applyDraft(existing, draft, receivedAt);
    this.events.set(r.event.id, r.event);
    this.byKey.set(draft.matchKey, r.event.id);
    if (r.change !== "unchanged") {
      const list = this.revs.get(r.event.id) ?? [];
      list.push({ revision: r.event.revision, event: r.event, changedFields: r.changedFields, changedAt: receivedAt });
      this.revs.set(r.event.id, list);
    }
    return r;
  }
  async recordIngest(run: IngestRun): Promise<void> {
    this.runs.set(run.underlyingId, run);
  }
  async coverage(underlyingIds: string[]): Promise<Coverage[]> {
    return underlyingIds.map((u) => coverageFromRun(u, this.runs.get(u)));
  }
  /** 测试用：直接放入一个事件（非财报源） */
  seed(event: MarketEvent, matchKey = event.id): void {
    this.events.set(event.id, event);
    this.byKey.set(matchKey, event.id);
    const list = this.revs.get(event.id) ?? [];
    list.push({ revision: event.revision, event, changedFields: [], changedAt: event.firstKnownAt });
    this.revs.set(event.id, list);
  }
}

export class MemoryEvidenceSink implements EvidenceSink {
  readonly records: Array<{ record: EvidenceRecord; refId: string; version: number }> = [];
  async write(record: EvidenceRecord, ref: { refId: string; version: number }): Promise<void> {
    this.records.push({ record, ...ref });
  }
  async forRef(refId: string): Promise<EvidenceRecord[]> {
    return this.records.filter((r) => r.refId === refId).map((r) => r.record);
  }
}

/* ---------------- Drizzle 实现 ---------------- */

const asDate = (iso: IsoUtc | null | undefined): Date | null => (iso ? new Date(iso) : null);

export class DrizzleEventStore implements EventStore {
  constructor(private readonly db: Db) {}

  async get(id: string): Promise<MarketEvent | null> {
    const row = (await this.db.select().from(verifyEvents).where(eq(verifyEvents.id, id)).limit(1))[0];
    return row ? (row.eventJson as MarketEvent) : null;
  }
  async list(filter: EventListFilter = {}): Promise<MarketEvent[]> {
    const conds = [];
    if (filter.kinds && filter.kinds.length > 0) conds.push(inArray(verifyEvents.kind, filter.kinds));
    if (filter.fromDate) conds.push(gte(verifyEvents.dateLocal, filter.fromDate));
    if (filter.toDate) conds.push(lte(verifyEvents.dateLocal, filter.toDate));
    const rows = conds.length > 0 ? await this.db.select().from(verifyEvents).where(and(...conds)) : await this.db.select().from(verifyEvents);
    return rows
      .map((r) => r.eventJson as MarketEvent)
      .filter((e) => matchesFilter(e, { underlyingIds: filter.underlyingIds }))
      .sort((a, b) => a.dateLocal.localeCompare(b.dateLocal) || a.id.localeCompare(b.id));
  }
  async revisions(id: string): Promise<EventRevisionRow[]> {
    const rows = await this.db.select().from(verifyEventRevisions).where(eq(verifyEventRevisions.eventId, id)).orderBy(verifyEventRevisions.revision);
    return rows.map((r) => ({ revision: r.revision, event: r.eventJson as MarketEvent, changedFields: r.changedFields as string[], changedAt: r.changedAt.toISOString() }));
  }
  async upsert(draft: EarningsEventDraft, receivedAt: IsoUtc): Promise<EventUpsertResult> {
    const key = (await this.db.select().from(verifyEarningsPeriods).where(eq(verifyEarningsPeriods.matchKey, draft.matchKey)).limit(1))[0];
    const existing = key ? await this.get(key.eventId) : null;
    const r = applyDraft(existing, draft, receivedAt);
    const now = new Date(receivedAt);
    const e = r.event;
    const values = {
      kind: e.kind,
      name: e.name,
      underlyingIds: e.underlyingIds,
      scheduledAtUtc: asDate(e.scheduledAtUtc),
      dateLocal: e.dateLocal,
      datePrecision: e.datePrecision,
      sessionHint: e.sessionHint,
      status: e.status,
      revision: e.revision,
      revisedFrom: e.revisedFrom ?? null,
      source: e.source,
      sourceFetchedAt: new Date(e.sourceFetchedAt),
      firstKnownAt: new Date(e.firstKnownAt),
      releasedAt: asDate(e.releasedAt),
      tz: e.tz,
      eventJson: e,
      updatedAt: now,
    };
    await this.db.transaction(async (tx) => {
      if (!existing) {
        await tx.insert(verifyEvents).values({ id: e.id, ...values, createdAt: now }).onConflictDoUpdate({ target: verifyEvents.id, set: values });
        await tx.insert(verifyEarningsPeriods).values({ matchKey: draft.matchKey, eventId: e.id, createdAt: now }).onConflictDoNothing();
      } else {
        await tx.update(verifyEvents).set(values).where(eq(verifyEvents.id, e.id));
      }
      if (r.change !== "unchanged") {
        await tx.insert(verifyEventRevisions).values({ eventId: e.id, revision: e.revision, eventJson: e, changedFields: r.changedFields, changedAt: now }).onConflictDoNothing();
      }
    });
    return r;
  }
  async recordIngest(run: IngestRun): Promise<void> {
    await this.db.insert(verifyEarningsIngests).values({
      id: run.id,
      source: run.source,
      symbol: run.symbol,
      underlyingId: run.underlyingId,
      httpStatus: run.httpStatus,
      ok: run.ok,
      rowCount: run.rowCount,
      rawHash: run.rawHash,
      requestedAt: new Date(run.requestedAt),
      receivedAt: new Date(run.receivedAt),
      fromDate: run.fromDate,
      toDate: run.toDate,
      eventIds: run.eventIds,
      evidenceIds: run.evidenceIds,
      createdAt: new Date(run.receivedAt),
    });
  }
  async coverage(underlyingIds: string[]): Promise<Coverage[]> {
    if (underlyingIds.length === 0) return [];
    const rows = await this.db.select().from(verifyEarningsIngests).where(inArray(verifyEarningsIngests.underlyingId, underlyingIds)).orderBy(desc(verifyEarningsIngests.receivedAt));
    const latest = new Map<string, IngestRun>();
    for (const r of rows) {
      if (latest.has(r.underlyingId)) continue;
      latest.set(r.underlyingId, {
        id: r.id,
        source: r.source,
        symbol: r.symbol,
        underlyingId: r.underlyingId,
        httpStatus: r.httpStatus,
        ok: r.ok,
        rowCount: r.rowCount,
        rawHash: r.rawHash,
        requestedAt: r.requestedAt.toISOString(),
        receivedAt: r.receivedAt.toISOString(),
        fromDate: r.fromDate,
        toDate: r.toDate,
        eventIds: r.eventIds as string[],
        evidenceIds: r.evidenceIds as string[],
      });
    }
    return underlyingIds.map((u) => coverageFromRun(u, latest.get(u)));
  }
}

/** 事件证据落 verify_evidence：job_id = `evt:<eventId>`，report_version = revision（回放 Lane E 从同一张表读） */
export class DrizzleEvidenceSink implements EvidenceSink {
  constructor(private readonly db: Db) {}
  async write(record: EvidenceRecord, ref: { refId: string; version: number }): Promise<void> {
    await this.db.insert(verifyEvidence).values({ evidenceId: record.evidenceId, jobId: `evt:${ref.refId}`, reportVersion: ref.version, record, rawRef: null, createdAt: new Date(record.time.receivedAt) }).onConflictDoNothing();
  }
  async forRef(refId: string): Promise<EvidenceRecord[]> {
    const rows = await this.db.select().from(verifyEvidence).where(eq(verifyEvidence.jobId, `evt:${refId}`)).orderBy(desc(verifyEvidence.reportVersion));
    return rows.map((r) => r.record as EvidenceRecord);
  }
}
