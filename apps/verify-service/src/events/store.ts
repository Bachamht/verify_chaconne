/**
 * 事件存储（Lane B 读写口）：表用 Lane D 在 packages/db/src/schema.ts 定义的 `verify_events` / `verify_event_revisions`（同名同义，不再另定义）。
 * 语义（interfaces §11.2）：按 id 合并、revision 递增才更新、修订史不可变；`firstKnownAt` 取首次入库时刻与 producer 值的较早者。
 * D 的财报摄入（DrizzleEventStore）写同一张表；这里只处理 crowsnest 导出的宏观/联储/日历事件。
 *
 * v7 · 事件实际值（interfaces §12.7）：revision 递增的更新里比较 outcome 规范化哈希 →
 * 写 outcome_json / outcome_hash / outcome_revision / outcome_received_at（列总是写，供时延测量）；
 * 开关 `cfg.v7.outcomes` 开时：首次附上 = `data_arrived`（不是 revised），之后哈希变化 = `revised`，并调用 outcomeHooks；
 * 读口带 outcome / outcomeRevision / dataStatus。开关关 → 分类、通知、读口与 v6 完全一致。
 * revision 不递增的更新仍然整条丢弃（包括新附上的 outcome）——producer 必须 revision + 1（D-08）。
 */
import { and, asc, desc, eq, gte, lte } from "drizzle-orm";
import type { Db } from "@chaconne/db";
import { verifyEventRevisions, verifyEvents } from "@chaconne/db";
import { deriveOutcomeChange, keccak256Utf8, mergeEventRevision, eventEvidencePayload, type EventKind, type EventOutcome, type EvidenceMode, type EvidenceRecord, type MarketEvent, type MarketEventV7 } from "@chaconne/core/verify";
import { newId } from "../ids";
import { annotateRevisionOutcomes, OutcomeHookRegistry, stripOutcome, v7View, type OutcomeHookInfo } from "./outcomes";

export type EventRow = typeof verifyEvents.$inferSelect;

export interface EventUpsertResult {
  inserted: string[];
  revised: string[];
  unchanged: string[];
  /** 逐条变更（与 Lane D `EventUpsertResult` 同形），供修订传播：created 不传播，revised / released / data_arrived 才发 event.* 通知并重算受影响任务 */
  changes: EventChangeRecord[];
}
export interface EventChangeRecord {
  event: MarketEvent;
  /** data_arrived 只在 v7 outcomes 开关打开时出现（首次附上 outcome） */
  change: "created" | "revised" | "released" | "data_arrived";
  changedFields: string[];
  previous: MarketEvent | null;
  /** 服务端派生的 outcome 修订号（有 outcome 时） */
  outcomeRevision?: number;
}

export interface EventStoreOptions {
  /** cfg.v7.outcomes（缺省 false） */
  outcomes?: boolean;
  now?: () => Date;
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
  private outcomesEnabled: boolean;
  private readonly now: () => Date;
  /** 实际值回调（Lane A：`events.outcomeHooks.set({ onDataArrived })`）；只在开关打开且 emitHooks≠false 时调用 */
  readonly outcomeHooks = new OutcomeHookRegistry();
  constructor(
    private readonly db: Db,
    opts: EventStoreOptions = {},
  ) {
    this.outcomesEnabled = opts.outcomes ?? false;
    this.now = opts.now ?? (() => new Date());
  }

  /** cfg.v7.outcomes（routes/v7d.ts 装配时按配置设置） */
  setOutcomesEnabled(on: boolean): void {
    this.outcomesEnabled = on;
  }
  get outcomes(): boolean {
    return this.outcomesEnabled;
  }

  /**
   * @param opts.emitHooks 默认 true；crowsnest 非 live（backfill / sample）快照传 false——回填数据不开轮次
   */
  async upsert(events: readonly MarketEventV7[], receivedAt: Date, opts: { emitHooks?: boolean } = {}): Promise<EventUpsertResult> {
    const res: EventUpsertResult = { inserted: [], revised: [], unchanged: [], changes: [] };
    const hookQueue: OutcomeHookInfo[] = [];
    for (const raw of events) {
      // producer 不得给服务端派生字段
      const { outcomeRevision: _r, dataStatus: _s, ...incoming } = raw;
      void _r;
      void _s;
      const row = (await this.db.select().from(verifyEvents).where(eq(verifyEvents.id, incoming.id)).limit(1))[0];
      const existing = row ? (row.eventJson as MarketEventV7) : null;
      const merged = mergeEventRevision(existing, incoming, receivedAt.toISOString());
      if (!merged) {
        res.unchanged.push(incoming.id);
        continue;
      }
      const ev: MarketEventV7 = merged.event;
      // producer 后续修订没带 outcome：实际值不会「消失」——沿用已入库的那份
      if (!ev.outcome && row?.outcomeJson) ev.outcome = row.outcomeJson as EventOutcome;
      const oc = deriveOutcomeChange(row?.outcomeHash ? { hash: row.outcomeHash, outcomeRevision: row.outcomeRevision } : null, ev.outcome);
      const outcomeChanged = oc.kind === "data_arrived" || oc.kind === "revised";
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
        outcomeJson: ev.outcome ?? null,
        outcomeHash: oc.kind === "none" ? (row?.outcomeHash ?? null) : oc.hash,
        outcomeRevision: oc.kind === "none" ? (row?.outcomeRevision ?? 0) : oc.outcomeRevision,
        outcomeReceivedAt: outcomeChanged ? receivedAt : (row?.outcomeReceivedAt ?? null),
      };
      if (merged.isNew) {
        await this.db.insert(verifyEvents).values({ id: ev.id, ...values, createdAt: receivedAt }).onConflictDoUpdate({ target: verifyEvents.id, set: values });
        res.inserted.push(ev.id);
      } else {
        await this.db.update(verifyEvents).set(values).where(eq(verifyEvents.id, ev.id));
        res.revised.push(ev.id);
      }
      const legacyChange = merged.isNew ? "created" : ev.status === "released" && existing?.status !== "released" ? "released" : "revised";
      let change: EventChangeRecord["change"] = legacyChange;
      let fields = changedFields(existing ? stripOutcome(existing) : null, ev);
      if (this.outcomesEnabled && outcomeChanged) {
        // 首次附上 → data_arrived（不发 event.revised）；之后哈希变化 → revised
        change = oc.kind === "data_arrived" ? "data_arrived" : "revised";
        fields = [...fields.filter((f) => f !== "created"), "outcome"];
        hookQueue.push({ eventId: ev.id, revision: ev.revision, outcomeRevision: oc.outcomeRevision, change: oc.kind, receivedAt: receivedAt.toISOString(), provider: ev.outcome!.provider });
      }
      const outRev = oc.kind === "none" ? 0 : oc.outcomeRevision;
      res.changes.push({
        event: this.outcomesEnabled ? v7View(ev, ev.outcome, outRev, receivedAt.getTime()) : stripOutcome(ev),
        change,
        changedFields: fields,
        previous: existing ? (this.outcomesEnabled ? existing : stripOutcome(existing)) : null,
        ...(oc.kind !== "none" ? { outcomeRevision: outRev } : {}),
      });
      await this.db.insert(verifyEventRevisions).values({ eventId: ev.id, revision: ev.revision, eventJson: ev, changedFields: fields, changedAt: receivedAt }).onConflictDoNothing();
    }
    if (this.outcomesEnabled && opts.emitHooks !== false) for (const h of hookQueue) await this.outcomeHooks.emit(h);
    return res;
  }

  private view(row: EventRow, nowMs: number): MarketEvent {
    const ev = row.eventJson as MarketEventV7;
    if (!this.outcomesEnabled) return stripOutcome(ev);
    return v7View(ev, (row.outcomeJson as EventOutcome | null) ?? null, row.outcomeRevision, nowMs);
  }

  private async revisionRows(id: string, asOf?: Date): Promise<Array<{ revision: number; event: MarketEvent; changedAtMs: number; changedFields: string[] }>> {
    const conds = [eq(verifyEventRevisions.eventId, id), ...(asOf ? [lte(verifyEventRevisions.changedAt, asOf)] : [])];
    const rows = await this.db.select().from(verifyEventRevisions).where(and(...conds)).orderBy(asc(verifyEventRevisions.revision));
    return rows.map((r) => ({ revision: r.revision, event: r.eventJson as MarketEvent, changedAtMs: r.changedAt.getTime(), changedFields: (r.changedFields as string[]) ?? [] }));
  }

  async byId(id: string): Promise<MarketEvent | null> {
    const row = (await this.db.select().from(verifyEvents).where(eq(verifyEvents.id, id)).limit(1))[0];
    return row ? this.view(row, this.now().getTime()) : null;
  }

  async list(f: EventListFilter = {}): Promise<MarketEvent[]> {
    const conds = [];
    if (f.from) conds.push(gte(verifyEvents.dateLocal, f.from));
    if (f.to) conds.push(lte(verifyEvents.dateLocal, f.to));
    if (f.kind) conds.push(eq(verifyEvents.kind, f.kind));
    const rows = await this.db.select().from(verifyEvents).where(conds.length ? and(...conds) : undefined).orderBy(asc(verifyEvents.dateLocal), asc(verifyEvents.id)).limit(f.limit ?? 500);
    const nowMs = this.now().getTime();
    let events = rows.map((r) => this.view(r, nowMs));
    if (f.underlyingId) events = events.filter((e) => e.underlyingIds.includes(f.underlyingId!) || e.underlyingIds.length === 0);
    return events;
  }

  /** 回放用：只取 firstKnownAt ≤ asOf 的版本（修订史里最晚且 changedAt ≤ asOf 的那条） */
  async listKnownAsOf(asOf: Date, f: EventListFilter = {}): Promise<MarketEvent[]> {
    const latest = await this.list(f);
    const out: MarketEvent[] = [];
    for (const ev of latest) {
      if (Date.parse(ev.firstKnownAt) > asOf.getTime()) continue;
      if (this.outcomesEnabled) {
        // 只用 asOf 前已入库的修订：outcomeRevision 按这些修订重放派生；dataStatus 按 asOf（无前视）
        const revs = annotateRevisionOutcomes(await this.revisionRows(ev.id, asOf));
        const last = revs[revs.length - 1];
        if (last) out.push(v7View(last.event, last.event.outcome, last.event.outcomeRevision ?? 0, asOf.getTime()));
        continue;
      }
      const revs = await this.db.select().from(verifyEventRevisions).where(and(eq(verifyEventRevisions.eventId, ev.id), lte(verifyEventRevisions.changedAt, asOf))).orderBy(desc(verifyEventRevisions.revision)).limit(1);
      if (revs[0]) out.push(stripOutcome(revs[0].eventJson as MarketEvent));
    }
    return out;
  }

  /** 修订史；开关开时每条 event 带 outcome / outcomeRevision（按修订重放派生）/ dataStatus（该修订入库时刻） */
  async revisions(id: string): Promise<Array<{ revision: number; receivedAt: string; changedFields: string[]; event: MarketEvent }>> {
    const rows = await this.revisionRows(id);
    const events = this.outcomesEnabled ? annotateRevisionOutcomes(rows) : rows.map((r) => ({ ...r, event: stripOutcome(r.event) }));
    return events.map((r) => ({ revision: r.revision, receivedAt: new Date(r.changedAtMs).toISOString(), changedFields: r.changedFields, event: r.event }));
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
