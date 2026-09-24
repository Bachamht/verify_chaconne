/**
 * 事件存储（Lane B 读写口）：表用 Lane D 在 packages/db/src/schema.ts 定义的 `verify_events` / `verify_event_revisions`（同名同义，不再另定义）。
 * 语义（interfaces §11.2）：按 id 合并、revision 递增才更新、修订史不可变；`firstKnownAt` 取首次入库时刻与 producer 值的较早者。
 * D 的财报摄入（DrizzleEventStore）写同一张表；这里只处理 crowsnest 导出的宏观/联储/日历事件。
 */
import { and, asc, desc, eq, gte, lte } from "drizzle-orm";
import type { Db } from "@chaconne/db";
import { verifyEventRevisions, verifyEvents } from "@chaconne/db";
import { keccak256Utf8, mergeEventRevision, eventEvidencePayload, type EventKind, type EvidenceMode, type EvidenceRecord, type MarketEvent } from "@chaconne/core/verify";
import { newId } from "../ids";

export type EventRow = typeof verifyEvents.$inferSelect;

export interface EventUpsertResult {
  inserted: string[];
  revised: string[];
  unchanged: string[];
  /** 逐条变更（与 Lane D `EventUpsertResult` 同形），供修订传播：created 不传播，revised / released 才发 event.* 通知并重算受影响任务 */
  changes: EventChangeRecord[];
}
export interface EventChangeRecord {
  event: MarketEvent;
  change: "created" | "revised" | "released";
  changedFields: string[];
  previous: MarketEvent | null;
}

export interface EventListFilter {
  from?: string;
  to?: string;
  underlyingId?: string;
  kind?: EventKind;
  limit?: number;
}

const REVISION_FIELDS = ["dateLocal", "scheduledAtUtc", "sessionHint", "datePrecision", "status", "name", "releasedAt"] as const;
function changedFields(prev: MarketEvent | null, next: MarketEvent): string[] {
  if (!prev) return ["created"];
  return REVISION_FIELDS.filter((k) => JSON.stringify(prev[k] ?? null) !== JSON.stringify(next[k] ?? null));
}

export class EventStore {
  constructor(private readonly db: Db) {}

  async upsert(events: readonly MarketEvent[], receivedAt: Date): Promise<EventUpsertResult> {
    const res: EventUpsertResult = { inserted: [], revised: [], unchanged: [], changes: [] };
    for (const incoming of events) {
      const row = (await this.db.select().from(verifyEvents).where(eq(verifyEvents.id, incoming.id)).limit(1))[0];
      const existing = row ? (row.eventJson as MarketEvent) : null;
      const merged = mergeEventRevision(existing, incoming, receivedAt.toISOString());
      if (!merged) {
        res.unchanged.push(incoming.id);
        continue;
      }
      const ev = merged.event;
      const values = {
        kind: ev.kind,
        name: ev.name,
        underlyingIds: ev.underlyingIds,
        scheduledAtUtc: ev.scheduledAtUtc ? new Date(ev.scheduledAtUtc) : null,
        dateLocal: ev.dateLocal,
        datePrecision: ev.datePrecision,
        sessionHint: ev.sessionHint,
        status: ev.status,
        revision: ev.revision,
        revisedFrom: ev.revisedFrom ?? null,
        source: ev.source,
        sourceFetchedAt: new Date(ev.sourceFetchedAt),
        firstKnownAt: new Date(ev.firstKnownAt),
        releasedAt: ev.releasedAt ? new Date(ev.releasedAt) : null,
        tz: ev.tz,
        eventJson: ev,
        updatedAt: receivedAt,
      };
      if (merged.isNew) {
        await this.db.insert(verifyEvents).values({ id: ev.id, ...values, createdAt: receivedAt }).onConflictDoUpdate({ target: verifyEvents.id, set: values });
        res.inserted.push(ev.id);
      } else {
        await this.db.update(verifyEvents).set(values).where(eq(verifyEvents.id, ev.id));
        res.revised.push(ev.id);
      }
      const fields = changedFields(existing, ev);
      res.changes.push({ event: ev, change: merged.isNew ? "created" : ev.status === "released" && existing?.status !== "released" ? "released" : "revised", changedFields: fields, previous: existing });
      await this.db.insert(verifyEventRevisions).values({ eventId: ev.id, revision: ev.revision, eventJson: ev, changedFields: fields, changedAt: receivedAt }).onConflictDoNothing();
    }
    return res;
  }

  async byId(id: string): Promise<MarketEvent | null> {
    const row = (await this.db.select().from(verifyEvents).where(eq(verifyEvents.id, id)).limit(1))[0];
    return row ? (row.eventJson as MarketEvent) : null;
  }

  async list(f: EventListFilter = {}): Promise<MarketEvent[]> {
    const conds = [];
    if (f.from) conds.push(gte(verifyEvents.dateLocal, f.from));
    if (f.to) conds.push(lte(verifyEvents.dateLocal, f.to));
    if (f.kind) conds.push(eq(verifyEvents.kind, f.kind));
    const rows = await this.db.select().from(verifyEvents).where(conds.length ? and(...conds) : undefined).orderBy(asc(verifyEvents.dateLocal), asc(verifyEvents.id)).limit(f.limit ?? 500);
    let events = rows.map((r) => r.eventJson as MarketEvent);
    if (f.underlyingId) events = events.filter((e) => e.underlyingIds.includes(f.underlyingId!) || e.underlyingIds.length === 0);
    return events;
  }

  /** 回放用：只取 firstKnownAt ≤ asOf 的版本（修订史里最晚且 changedAt ≤ asOf 的那条） */
  async listKnownAsOf(asOf: Date, f: EventListFilter = {}): Promise<MarketEvent[]> {
    const latest = await this.list(f);
    const out: MarketEvent[] = [];
    for (const ev of latest) {
      if (Date.parse(ev.firstKnownAt) > asOf.getTime()) continue;
      const revs = await this.db.select().from(verifyEventRevisions).where(and(eq(verifyEventRevisions.eventId, ev.id), lte(verifyEventRevisions.changedAt, asOf))).orderBy(desc(verifyEventRevisions.revision)).limit(1);
      if (revs[0]) out.push(revs[0].eventJson as MarketEvent);
    }
    return out;
  }

  async revisions(id: string): Promise<Array<{ revision: number; receivedAt: string; changedFields: string[]; event: MarketEvent }>> {
    const rows = await this.db.select().from(verifyEventRevisions).where(eq(verifyEventRevisions.eventId, id)).orderBy(asc(verifyEventRevisions.revision));
    return rows.map((r) => ({ revision: r.revision, receivedAt: r.changedAt.toISOString(), changedFields: (r.changedFields as string[]) ?? [], event: r.eventJson as MarketEvent }));
  }

  /** market_event 证据记录（进条件求值与证据包） */
  evidenceFor(ev: MarketEvent, nowIso: string, mode: EvidenceMode): EvidenceRecord {
    return {
      evidenceId: newId("evt"),
      provider: ev.source.split(":")[0] ?? ev.source,
      endpoint: "events",
      requestFingerprint: keccak256Utf8(`event:${ev.id}:${ev.revision}`),
      time: { requestedAt: nowIso, receivedAt: nowIso, sourcePublishedAt: new Date(Date.parse(ev.sourceFetchedAt)).toISOString(), sourceTimeKind: "published" },
      block: null,
      rawHash: keccak256Utf8(JSON.stringify(ev)),
      parserVersion: "market-event/1",
      mode,
      payload: eventEvidencePayload(ev),
    };
  }
}
