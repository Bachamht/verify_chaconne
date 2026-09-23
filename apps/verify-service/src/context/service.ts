/**
 * ContextService（C1）：最新快照读取、档位裁剪（X-04 绝不省略键）、按资产/任务过滤（X-05）、条件求值输入组装。
 * `GET /v1/context` 永远 200：不可达时全部字段 `unavailable`、meta.available=false。
 */
import { desc, eq } from "drizzle-orm";
import type { Db } from "@chaconne/db";
import { verifyContextSnapshots } from "@chaconne/db";
import {
  applyFieldStatus,
  assessContextStaleness,
  CONTEXT_FIELD_PATHS,
  contextPathSet,
  filterContext,
  filterFromConditions,
  findEntry,
  trimContextToTier,
  type AssetRegistry,
  type Condition,
  type ContextTier,
  type CtxField,
  type CtxStatus,
  type EvidenceMode,
  type EvidenceRecord,
  type MarketContext,
  type MarketEvent,
} from "@chaconne/core/verify";
import type { ConditionEvidence } from "@chaconne/core/verify";
import type { ContextSnapshotRow } from "./crowsnest";
import type { EventStore } from "../events/store";

export interface ContextServiceDeps {
  db: Db;
  registry: AssetRegistry;
  events: EventStore;
  evidenceMode: EvidenceMode;
  now?: () => Date;
}

export interface ContextViewQuery {
  tier: ContextTier;
  assetKey?: string;
  underlyingIds?: string[];
  conditions?: Condition[];
}

export interface ContextMeta {
  available: boolean;
  reason: "CONTEXT_UNAVAILABLE" | null;
  tier: ContextTier;
  snapshotId: string | null;
  receivedAt: string | null;
  packagedAt: string | null;
  contextHash: string | null;
  signatureValid: boolean;
  publicKeyId: string | null;
  /** CV-D13：live | backfill | sample；非 live 的快照只供回放/联调，LIVE 任务视为不可用 */
  provenanceMode: "live" | "backfill" | "sample" | null;
  fieldStatus: Record<string, CtxStatus>;
  filter: { assetKey: string | null; underlyingIds: string[]; eventKinds: string[] | null };
  evidenceMode: EvidenceMode;
  note: string;
}

export class ContextService {
  private readonly now: () => Date;
  constructor(private readonly d: ContextServiceDeps) {
    this.now = d.now ?? (() => new Date());
  }

  async latestSnapshot(): Promise<ContextSnapshotRow | null> {
    return (await this.d.db.select().from(verifyContextSnapshots).orderBy(desc(verifyContextSnapshots.receivedAt)).limit(1))[0] ?? null;
  }
  /** 最近一次**验签通过**的快照（拒收行不算） */
  async latestValidSnapshot(): Promise<ContextSnapshotRow | null> {
    return (await this.d.db.select().from(verifyContextSnapshots).where(eq(verifyContextSnapshots.status, "ok")).orderBy(desc(verifyContextSnapshots.receivedAt)).limit(1))[0] ?? null;
  }

  underlyingOf(assetKey: string): string | null {
    return findEntry(this.d.registry, assetKey.toLowerCase())?.underlyingId ?? null;
  }

  /** 按档位 + 过滤组装响应（字段平铺在顶层，meta 另放） */
  async view(q: ContextViewQuery): Promise<Record<string, unknown> & { meta: ContextMeta }> {
    const latest = await this.latestSnapshot();
    const valid = latest && latest.status === "ok" ? latest : await this.latestValidSnapshot();
    const underlyingIds = [...(q.underlyingIds ?? [])];
    if (q.assetKey) {
      const u = this.underlyingOf(q.assetKey);
      if (u) underlyingIds.push(u);
    }
    const condFilter = q.conditions ? filterFromConditions(q.conditions) : null;
    const filter = { assetKey: q.assetKey ?? null, underlyingIds, eventKinds: condFilter?.eventKinds ?? null };
    if (!valid) {
      return { ...unavailableContextBody(this.now().toISOString()), meta: { available: false, reason: "CONTEXT_UNAVAILABLE", tier: q.tier, snapshotId: latest?.id ?? null, receivedAt: latest?.receivedAt.toISOString() ?? null, packagedAt: null, contextHash: null, signatureValid: false, publicKeyId: null, provenanceMode: null, fieldStatus: { "*": "unavailable" }, filter, evidenceMode: this.d.evidenceMode, note: latest ? `latest ingest ${latest.status}: ${latest.error ?? ""}` : "no context snapshot ingested yet" } };
    }
    const ctx = valid.contextJson as MarketContext;
    // 事件用 store 里的最新修订（含 Lane D 摄入的财报），不用快照里冻结的那份
    const storeEvents = await this.d.events.list({ limit: 1000 });
    const merged: MarketContext = { ...ctx, events: storeEvents.length ? storeEvents : ctx.events };
    const trimmed = trimContextToTier(merged, q.tier);
    const filtered = filterContext(trimmed, { ...(underlyingIds.length ? { underlyingIds } : {}), ...(condFilter ?? {}) });
    const { signature: _sig, ...body } = filtered;
    void _sig;
    const fieldStatus = valid.fieldStatus as Record<string, CtxStatus>;
    return {
      ...body,
      meta: { available: true, reason: null, tier: q.tier, snapshotId: valid.id, receivedAt: valid.receivedAt.toISOString(), packagedAt: valid.packagedAt?.toISOString() ?? null, contextHash: valid.contextHash, signatureValid: valid.signatureValid, publicKeyId: valid.publicKeyId, provenanceMode: (valid.provenanceMode ?? "live") as ContextMeta["provenanceMode"], fieldStatus, filter, evidenceMode: this.d.evidenceMode, note: latest && latest.id !== valid.id ? `latest ingest ${latest.status}; serving last valid snapshot` : "" },
    };
  }

  /** 条件求值输入的上下文部分（任务 / 理由卡 / 对照共用）。asOf 给了 = 回放口径（快照 receivedAt ≤ asOf、事件 firstKnownAt ≤ asOf）。 */
  async conditionEvidence(underlyingIds: readonly string[], asOf?: Date, opts: { allowNonLive?: boolean } = {}): Promise<Pick<ConditionEvidence, "context" | "events" | "earningsCoverage"> & { records: EvidenceRecord[] }> {
    const nowIso = (asOf ?? this.now()).toISOString();
    let snap: ContextSnapshotRow | null;
    if (asOf) {
      snap = (await this.d.db.select().from(verifyContextSnapshots).where(eq(verifyContextSnapshots.status, "ok")).orderBy(desc(verifyContextSnapshots.receivedAt)).limit(50)).find((r) => r.receivedAt.getTime() <= asOf.getTime()) ?? null;
    } else snap = await this.latestValidSnapshot();
    const events: MarketEvent[] = asOf ? await this.d.events.listKnownAsOf(asOf) : await this.d.events.list({ limit: 1000 });
    const relevant = events.filter((e) => e.underlyingIds.length === 0 || e.underlyingIds.some((u) => underlyingIds.includes(u)));
    const records: EvidenceRecord[] = [];
    const evidenceRecords = relevant.map((e) => {
      const rec = this.d.events.evidenceFor(e, nowIso, asOf ? "REPLAY" : this.d.evidenceMode);
      records.push(rec);
      return { event: e, evidenceId: rec.evidenceId };
    });
    // 财报覆盖：Lane D 摄入前一律未知（不伪装成"无财报"）；有任何该标的的 EARNINGS 事件即视为覆盖
    const earningsCoverage: Record<string, boolean> = {};
    for (const u of underlyingIds) if (events.some((e) => e.kind === "EARNINGS" && e.underlyingIds.includes(u))) earningsCoverage[u] = true;
    if (!snap) return { context: null, events: evidenceRecords, earningsCoverage, records };
    // CV-D13：backfill / sample 快照不得参与 LIVE 判定（只用于回放与联调）
    if (!opts.allowNonLive && !asOf && (snap.provenanceMode ?? "live") !== "live") return { context: null, events: evidenceRecords, earningsCoverage, records };
    const evidence = snap.evidenceJson as EvidenceRecord;
    records.push(evidence);
    // 用现在（或 asOf）重新判定 staleness：快照入库时 ok 的字段到评估时点可能已过期
    const ctx = snap.contextJson as MarketContext;
    const fieldStatus = assessContextStaleness(ctx, nowIso);
    return { context: { snapshot: applyFieldStatus(ctx, fieldStatus), fieldStatus, evidenceId: evidence.evidenceId, receivedAt: snap.receivedAt.toISOString() }, events: evidenceRecords, earningsCoverage, records };
  }

  /** 快照里的证据记录（进证据包） */
  async evidenceRecordOf(snapshotId: string) {
    const row = (await this.d.db.select().from(verifyContextSnapshots).where(eq(verifyContextSnapshots.id, snapshotId)).limit(1))[0];
    return row ? (row.evidenceJson as EvidenceRecord) : null;
  }
}

/** 不可达时的响应体：全部契约键齐全、全部 unavailable */
export function unavailableContextBody(nowIso: string): Record<string, unknown> {
  const body: Record<string, unknown> = { schemaVersion: "chaconne-context/1", producer: "crowsnest", packagedAt: null, signatureAlg: "ed25519", publicKeyId: null, events: [] };
  for (const [path] of CONTEXT_FIELD_PATHS) contextPathSet(body, path, { value: null, source: "verify-service", observedAt: null, fetchedAt: nowIso, status: "unavailable", purposes: [], note: "context_unavailable" } satisfies CtxField<null>);
  return body;
}
