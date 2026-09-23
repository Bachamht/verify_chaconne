/**
 * `market_context` 证据记录（CV-D，interfaces §11.12）与「不可达」证据。
 * 全量快照入 verify_context_snapshots；证据里只放 hash + 验签结果 + 逐字段 status。
 */
import { keccak256Utf8 } from "../canonical";
import type { Bytes32, CtxStatus, EvidenceMode, EvidenceRecord, IsoUtc, MarketContext } from "../contracts";
import { contextHash } from "./hash";
import type { FieldStatusMap } from "./staleness";

export interface ContextEvidenceArgs {
  /** contextHash 按原文（含未知键）计算，与签名载荷一致 */
  contextHashOfRaw?: Bytes32;
  evidenceId: string;
  endpoint: string;
  requestedAt: IsoUtc;
  receivedAt: IsoUtc;
  rawText: string;
  mode: EvidenceMode;
  signatureValid: boolean;
  fieldStatus: FieldStatusMap;
}

export const CONTEXT_PARSER_VERSION = "crowsnest-context/1";

export function buildContextEvidence(ctx: MarketContext, a: ContextEvidenceArgs): EvidenceRecord {
  return {
    evidenceId: a.evidenceId,
    provider: "crowsnest",
    endpoint: a.endpoint,
    requestFingerprint: keccak256Utf8(`context:${ctx.publicKeyId}:${ctx.packagedAt}`),
    time: { requestedAt: a.requestedAt, receivedAt: a.receivedAt, sourcePublishedAt: new Date(Date.parse(ctx.packagedAt)).toISOString(), sourceTimeKind: "published" },
    block: null,
    rawHash: keccak256Utf8(a.rawText),
    parserVersion: CONTEXT_PARSER_VERSION,
    mode: a.mode,
    payload: { kind: "market_context", schemaVersion: "chaconne-context/1", producer: "crowsnest", packagedAt: ctx.packagedAt, publicKeyId: ctx.publicKeyId, signatureValid: a.signatureValid, contextHash: a.contextHashOfRaw ?? contextHash(ctx), fieldStatus: a.fieldStatus },
  };
}

/** 不可达 / 验签失败 / 结构不合法：整份拒收，证据仍要留痕（CONTEXT_UNAVAILABLE 的依据） */
export function buildUnavailableContextEvidence(a: { evidenceId: string; endpoint: string; requestedAt: IsoUtc; receivedAt: IsoUtc; rawText: string | null; mode: EvidenceMode; reason: string; publicKeyId?: string; packagedAt?: IsoUtc }): EvidenceRecord {
  const zero = ("0x" + "0".repeat(64)) as Bytes32;
  const fieldStatus: Record<string, CtxStatus> = { "*": "unavailable" };
  return {
    evidenceId: a.evidenceId,
    provider: "crowsnest",
    endpoint: a.endpoint,
    requestFingerprint: keccak256Utf8(`context:unavailable:${a.reason}`),
    time: { requestedAt: a.requestedAt, receivedAt: a.receivedAt, sourcePublishedAt: null, sourceTimeKind: "not_provided" },
    block: null,
    rawHash: a.rawText === null ? zero : keccak256Utf8(a.rawText),
    parserVersion: CONTEXT_PARSER_VERSION,
    mode: a.mode,
    payload: { kind: "market_context", schemaVersion: "chaconne-context/1", producer: "crowsnest", packagedAt: a.packagedAt ?? a.receivedAt, publicKeyId: a.publicKeyId ?? "", signatureValid: false, contextHash: zero, fieldStatus },
  };
}
