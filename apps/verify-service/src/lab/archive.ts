/**
 * 回放档案读取（三类数据源）：
 *  1. verify_evidence（9/20 起）：按 created_at 取区间，再按资产过滤（quote 的 from/to、参考价的 underlyingId、上下文/事件全收）；
 *  2. verify_context_snapshots + crowsnest 30 天回填：表由 Lane C 迁移 0018 建，列名假定 `received_at` / `packaged_at` / `context_json`
 *     （不存在或列名不同 → 该来源为空，回放如实标 NO_ARCHIVE，不伪装）；事件版本从其中 context_json.events 与 verify_evidence 的 market_event 记录合并；
 *  3. Chaconne premium_1h：只作参考价/链上价背景；断供清空区间 = 首末 bar 之间缺失的常规时段小时桶（REFERENCE_PURGED）。
 * 绝不把参考价当 quote；绝不补值。
 */
import { and, asc, eq, gte, lte, sql } from "drizzle-orm";
import type { Db } from "@chaconne/db";
import { assets, premium1h, verifyEvidence } from "@chaconne/db";
import { sessionAt } from "@chaconne/core";
import type { EvidenceRecord, IsoUtc, MarketContext, MarketEvent, RegistryEntry, ReplayArchive } from "@chaconne/core/verify";
import { REPLAY_EVIDENCE_LOOKBACK_MS } from "@chaconne/core/verify";
import { log } from "../log";

export interface ArchiveQuery {
  entry: RegistryEntry;
  from: IsoUtc;
  to: IsoUtc;
}

export interface ReplayArchiveReader {
  read(q: ArchiveQuery): Promise<ReplayArchive>;
}

/** 测试 / 演示：直接给定档案（读取时仍按资产过滤证据） */
export class InMemoryReplayArchive implements ReplayArchiveReader {
  constructor(private readonly archive: ReplayArchive) {}
  async read(q: ArchiveQuery): Promise<ReplayArchive> {
    return { ...this.archive, records: this.archive.records.filter((r) => recordConcernsAsset(r, q.entry)) };
  }
}

export function recordConcernsAsset(r: EvidenceRecord, e: RegistryEntry): boolean {
  const p = r.payload;
  const addr = e.tokenAddress.toLowerCase();
  switch (p.kind) {
    case "okx_quote":
      return p.fromToken.toLowerCase() === addr || p.toToken.toLowerCase() === addr;
    case "okx_rwa_token":
    case "token_meta":
      return p.tokenAddress.toLowerCase() === addr;
    case "pyth_reference":
    case "ref_close":
      return p.underlyingId === e.underlyingId;
    case "market_event":
      return true; // 宏观事件 underlyingIds 为空；财报按 underlyingIds 由求值器再过滤
    case "market_context":
    case "stablecoin_usd":
    case "registry_lookup":
    case "portfolio_snapshot":
      return true;
    default:
      return false;
  }
}

/** 首末 bar 之间缺失的常规时段小时桶 → 清空区间（纯函数，可测） */
export function derivePurgedRanges(bars: ReplayArchive["referenceBars"]): Array<{ from: IsoUtc; to: IsoUtc }> {
  const have = new Set(bars.filter((b) => b.refPriceUsd !== null || b.tokenPriceUsd !== null).map((b) => Date.parse(b.ts)));
  if (have.size === 0) return [];
  const sorted = [...have].sort((a, b) => a - b);
  const first = sorted[0]!;
  const last = sorted[sorted.length - 1]!;
  const HOUR = 3600_000;
  const out: Array<{ from: IsoUtc; to: IsoUtc }> = [];
  for (let t = first; t <= last; t += HOUR) {
    if (have.has(t)) continue;
    if (sessionAt(new Date(t)).session !== "REGULAR") continue;
    const from = new Date(t).toISOString();
    const to = new Date(t + HOUR).toISOString();
    const prev = out[out.length - 1];
    if (prev && prev.to === from) prev.to = to;
    else out.push({ from, to });
  }
  return out;
}

export class DbReplayArchive implements ReplayArchiveReader {
  constructor(private readonly db: Db) {}

  async read(q: ArchiveQuery): Promise<ReplayArchive> {
    const fromDate = new Date(Date.parse(q.from) - REPLAY_EVIDENCE_LOOKBACK_MS);
    const toDate = new Date(q.to);

    // 1) verify_evidence
    const evRows = await this.db.select({ record: verifyEvidence.record }).from(verifyEvidence).where(and(gte(verifyEvidence.createdAt, fromDate), lte(verifyEvidence.createdAt, toDate))).orderBy(asc(verifyEvidence.createdAt));
    const records = evRows.map((r) => r.record as EvidenceRecord).filter((r) => r && r.time && recordConcernsAsset(r, q.entry));

    // 2) verify_context_snapshots（表/列由 Lane C 迁移定义；不存在 → 空）
    const contextSnapshots: ReplayArchive["contextSnapshots"] = [];
    const eventVersions = new Map<string, MarketEvent>();
    try {
      const rows = (await this.db.execute(sql`SELECT received_at, context_json FROM verify_context_snapshots WHERE received_at >= ${fromDate.toISOString()}::timestamptz AND received_at <= ${toDate.toISOString()}::timestamptz ORDER BY received_at ASC`)) as unknown as { rows?: Array<{ received_at: string | Date; context_json: MarketContext }> } | Array<{ received_at: string | Date; context_json: MarketContext }>;
      const list = Array.isArray(rows) ? rows : (rows.rows ?? []);
      for (const row of list) {
        const ctx = row.context_json;
        if (!ctx || typeof ctx !== "object" || !ctx.packagedAt) continue;
        const receivedAt = new Date(row.received_at).toISOString();
        contextSnapshots.push({ receivedAt, context: ctx });
        for (const e of ctx.events ?? []) eventVersions.set(`${e.id}#${e.revision}`, e);
      }
    } catch (err) {
      log.warn("lab: verify_context_snapshots 不可读（迁移 0018 未到或列名不同），该来源记为空", { error: err instanceof Error ? err.message.slice(0, 120) : String(err) });
    }
    for (const r of records) {
      if (r.payload.kind !== "market_event") continue;
      const p = r.payload;
      const key = `${p.eventId}#${p.revision}`;
      if (eventVersions.has(key)) continue;
      // 证据 payload 没有 name/tz 等展示字段：只用回放需要的时间字段，其余占位（不外泄、不预测）
      eventVersions.set(key, { id: p.eventId, kind: p.eventKind, name: p.eventId, underlyingIds: [], scheduledAtUtc: p.scheduledAtUtc, dateLocal: p.dateLocal, datePrecision: p.datePrecision, sessionHint: null, status: p.status, revision: p.revision, source: r.provider, sourceFetchedAt: r.time.receivedAt, firstKnownAt: p.firstKnownAt, tz: "America/New_York" });
    }

    // 3) premium_1h（按代币地址找 assets 行；只作背景）
    let referenceBars: ReplayArchive["referenceBars"] = [];
    try {
      const addr = q.entry.tokenAddress.toLowerCase();
      const a = (await this.db.select({ id: assets.id }).from(assets).where(sql`lower(${assets.address}) = ${addr}`).limit(1))[0];
      if (a) {
        const bars = await this.db.select({ ts: premium1h.ts, ref: premium1h.refPriceClose, tok: premium1h.tokenPriceClose }).from(premium1h).where(and(eq(premium1h.assetId, a.id), gte(premium1h.ts, new Date(q.from)), lte(premium1h.ts, toDate))).orderBy(asc(premium1h.ts));
        referenceBars = bars.map((b) => ({ ts: b.ts.toISOString(), refPriceUsd: b.ref ?? null, tokenPriceUsd: b.tok ?? null }));
      }
    } catch (err) {
      log.warn("lab: premium_1h 不可读，参考价背景记为空", { error: err instanceof Error ? err.message.slice(0, 120) : String(err) });
    }

    return { records, contextSnapshots, eventVersions: [...eventVersions.values()], referenceBars, referencePurged: derivePurgedRanges(referenceBars) };
  }
}
