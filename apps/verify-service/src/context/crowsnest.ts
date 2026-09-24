/**
 * crowsnest 上下文摄入（开发计划 §3.2 · interfaces §11.3）：
 *   拉取 → Ed25519 验签（公钥来自 env，按 publicKeyId）→ schema 校验 → 逐字段 staleness（本服务判定）
 *   → EvidenceRecord(kind:'market_context') + verify_context_snapshots；事件 → verify_events / verify_event_revisions。
 * 不可达 / 验签失败 / 结构不合法 → 整份拒收：写 `unavailable` 证据 + 快照行（status rejected|unavailable），条件层据此 CONTEXT_UNAVAILABLE。
 * 归档（history/*.jsonl）只能证明过去观测：mode 由调用方标（LIVE 只给 latest.json 的实时拉取）。
 */
import type { Db } from "@chaconne/db";
import { verifyContextSnapshots } from "@chaconne/db";
import {
  applyFieldStatus,
  assessContextStaleness,
  buildContextEvidence,
  buildUnavailableContextEvidence,
  contextHash,
  contextProvenanceMode,
  contextSigningPayload,
  validateMarketContext,
  type EvidenceMode,
  type EvidenceRecord,
  type MarketContext, type MarketEvent } from "@chaconne/core/verify";
import { newId } from "../ids";
import { log } from "../log";
import type { EventStore } from "../events/store";
import { parseKeyring, verifyEd25519, type CrowsnestKeyring } from "./keys";

export type ContextSnapshotRow = typeof verifyContextSnapshots.$inferSelect;

export interface CrowsnestDeps {
  db: Db;
  events: EventStore;
  /** 公钥环（env CROWSNEST_PUBKEY_ED25519） */
  keyring: CrowsnestKeyring;
  /** 注入 fetch（测试用假服务器） */
  fetchImpl?: typeof fetch;
  now?: () => Date;
}

/** 事件修订接收方（Lane D 的 EventRevisionPropagator.onChange 同形）：只收 revised / released */
export type EventChangeSink = (r: { event: MarketEvent; change: "revised" | "released"; changedFields: string[]; previous: MarketEvent | null }) => Promise<unknown>;

export type IngestOutcome =
  | { ok: true; snapshotId: string; contextHash: string; provenance: "live" | "backfill" | "sample"; fieldStatus: Record<string, string>; events: { inserted: string[]; revised: string[]; unchanged: string[] }; evidence: EvidenceRecord }
  | { ok: false; snapshotId: string; reason: "unreachable" | "invalid_json" | "schema_rejected" | "unknown_public_key" | "signature_invalid"; detail: unknown; evidence: EvidenceRecord };

export class CrowsnestAdapter {
  private eventSink: EventChangeSink | null = null;
  /** 后绑定修订传播（index.ts 在 Lane D 装配完成后调用） */
  setEventChangeSink(sink: EventChangeSink | null): void {
    this.eventSink = sink;
  }
  private readonly now: () => Date;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly d: CrowsnestDeps) {
    this.now = d.now ?? (() => new Date());
    this.fetchImpl = d.fetchImpl ?? fetch;
  }

  static keyringFromEnv(raw: string): CrowsnestKeyring {
    return parseKeyring(raw);
  }

  /** 拉取 latest.json 并摄入（mode LIVE）；不可达 → unavailable 证据 */
  async pull(url: string, mode: EvidenceMode = "LIVE"): Promise<IngestOutcome> {
    const requestedAt = this.now().toISOString();
    let text: string | null = null;
    try {
      const res = await this.fetchImpl(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      text = await res.text();
    } catch (err) {
      return this.reject({ requestedAt, endpoint: endpointOf(url), rawText: null, mode, reason: "unreachable", detail: err instanceof Error ? err.message.slice(0, 200) : String(err) });
    }
    return this.ingest(text, { requestedAt, endpoint: endpointOf(url), mode });
  }

  /** 摄入一份原文（联调可经 POST /v1/context/ingest 投递；归档回放调用方标 REPLAY） */
  async ingest(rawText: string, opts: { requestedAt?: string; endpoint: string; mode: EvidenceMode }): Promise<IngestOutcome> {
    const requestedAt = opts.requestedAt ?? this.now().toISOString();
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch {
      return this.reject({ requestedAt, endpoint: opts.endpoint, rawText, mode: opts.mode, reason: "invalid_json", detail: null });
    }
    const v = validateMarketContext(parsed);
    if (!v.ok) return this.reject({ requestedAt, endpoint: opts.endpoint, rawText, mode: opts.mode, reason: "schema_rejected", detail: v.errors.slice(0, 20) });
    const ctx = v.ctx;
    const pub = this.d.keyring.get(ctx.publicKeyId);
    if (!pub) return this.reject({ requestedAt, endpoint: opts.endpoint, rawText, mode: opts.mode, reason: "unknown_public_key", detail: { publicKeyId: ctx.publicKeyId, configured: this.d.keyring.ids }, ctx });
    // 验签覆盖 canonical(原文除 signature 外)：签名包含原文全部键（含本服务会剥离的未知键），所以对**原文**验签；
    // 校验重建后的对象（只含契约键）才入库/响应（X-06）。
    const payload = contextSigningPayload(parsed as Record<string, unknown>);
    if (!verifyEd25519(pub, payload, ctx.signature)) return this.reject({ requestedAt, endpoint: opts.endpoint, rawText, mode: opts.mode, reason: "signature_invalid", detail: { publicKeyId: ctx.publicKeyId }, ctx });

    // CV-D13：provenance.mode 决定证据模式——只有 live 才标 LIVE；backfill → REPLAY；sample → FIXTURE
    const provenance = contextProvenanceMode(ctx);
    const mode: EvidenceMode = provenance === "live" ? opts.mode : provenance === "backfill" ? "REPLAY" : "FIXTURE";
    const receivedAt = this.now().toISOString();
    const fieldStatus = assessContextStaleness(ctx, receivedAt);
    const stamped = applyFieldStatus(ctx, fieldStatus);
    const hashOfRaw = contextHash(parsed as Record<string, unknown>);
    const evidence = buildContextEvidence(stamped, { evidenceId: newId("ev"), endpoint: opts.endpoint, requestedAt, receivedAt, rawText, mode, signatureValid: true, fieldStatus, contextHashOfRaw: hashOfRaw });
    const id = newId("ctx");
    const receivedDate = new Date(receivedAt);
    await this.d.db.insert(verifyContextSnapshots).values({
      id,
      producer: ctx.producer,
      publicKeyId: ctx.publicKeyId,
      packagedAt: new Date(ctx.packagedAt),
      receivedAt: receivedDate,
      status: "ok",
      signatureValid: true,
      contextHash: hashOfRaw,
      provenanceMode: provenance,
      fieldStatus,
      contextJson: stamped,
      evidenceJson: evidence,
      rawHash: evidence.rawHash,
      sourceEndpoint: opts.endpoint,
      error: null,
      createdAt: receivedDate,
    });
    const upserted = await this.d.events.upsert(ctx.events, receivedDate);
    const events = { inserted: upserted.inserted, revised: upserted.revised, unchanged: upserted.unchanged };
    log.info("上下文快照已摄入", { id, publicKeyId: ctx.publicKeyId, packagedAt: ctx.packagedAt, provenance, stale: Object.entries(fieldStatus).filter(([, s]) => s !== "ok").length, events });
    // 宏观事件的改期 / 发布同样要传播到受影响任务并发 event.* 通知（此前只有 Lane D 自己摄入的财报会传播——2026-09-23 线上翻动期间 0 条通知的原因之一）
    if (this.eventSink && provenance === "live") {
      for (const c of upserted.changes) {
        if (c.change === "created") continue;
        try {
          await this.eventSink({ event: c.event, change: c.change, changedFields: c.changedFields, previous: c.previous });
        } catch (e) {
          log.warn("事件修订传播失败（摄入不受影响）", { eventId: c.event.id, revision: c.event.revision, error: e instanceof Error ? e.message : String(e) });
        }
      }
    }
    return { ok: true, snapshotId: id, contextHash: hashOfRaw, provenance, fieldStatus, events, evidence };
  }

  private async reject(a: { requestedAt: string; endpoint: string; rawText: string | null; mode: EvidenceMode; reason: Exclude<IngestOutcome, { ok: true }>["reason"]; detail: unknown; ctx?: MarketContext }): Promise<IngestOutcome> {
    const receivedAt = this.now().toISOString();
    const evidence = buildUnavailableContextEvidence({ evidenceId: newId("ev"), endpoint: a.endpoint, requestedAt: a.requestedAt, receivedAt, rawText: a.rawText, mode: a.mode, reason: a.reason, ...(a.ctx ? { publicKeyId: a.ctx.publicKeyId, packagedAt: a.ctx.packagedAt } : {}) });
    const id = newId("ctx");
    const receivedDate = new Date(receivedAt);
    await this.d.db.insert(verifyContextSnapshots).values({
      id,
      producer: "crowsnest",
      publicKeyId: a.ctx?.publicKeyId ?? null,
      packagedAt: a.ctx ? new Date(a.ctx.packagedAt) : null,
      receivedAt: receivedDate,
      status: a.reason === "unreachable" ? "unavailable" : "rejected",
      signatureValid: false,
      contextHash: null,
      provenanceMode: a.ctx ? contextProvenanceMode(a.ctx) : null,
      fieldStatus: { "*": "unavailable" },
      contextJson: null,
      evidenceJson: evidence,
      rawHash: evidence.rawHash,
      sourceEndpoint: a.endpoint,
      error: `${a.reason}${a.detail ? ":" + JSON.stringify(a.detail).slice(0, 500) : ""}`,
      createdAt: receivedDate,
    });
    log.warn("上下文拒收", { id, reason: a.reason, detail: a.detail });
    return { ok: false, snapshotId: id, reason: a.reason, detail: a.detail, evidence };
  }
}

/** 端点标识：去掉查询串（不含参数中的任何密钥） */
export function endpointOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}`;
  } catch {
    return url.split("?")[0] ?? url;
  }
}
