/**
 * 报告组装与哈希（技术设计 §5.2 / §5.3）。
 *
 * 顺序：证据清单 → evidenceHash → 报告 → (服务) 用户意图摘要 → 证明签名。
 * evidenceHash 的清单不含 evidenceHash 自身、intentDigest、签名或成交 hash。
 */
import { hashCanonical } from "./canonical";
import type {
  AssetRegistry,
  Bytes32,
  EffectivePolicy,
  EvidenceRecord,
  NormalizedJob,
  VerifyReport,
} from "./contracts";
import { evaluateVerification } from "./evaluate";
import type { MarketCalendar } from "../calendar";

export const EVIDENCE_LIST_VERSION = "evidence-1";
export const REQUEST_HASH_VERSION = "request-1";

/** 规范化证据清单（按 evidenceId 排序；字段固定）。 */
export function canonicalEvidenceList(evidence: EvidenceRecord[]) {
  return {
    version: EVIDENCE_LIST_VERSION,
    items: [...evidence]
      .sort((a, b) => (a.evidenceId < b.evidenceId ? -1 : a.evidenceId > b.evidenceId ? 1 : 0))
      .map((e) => ({
        evidenceId: e.evidenceId,
        provider: e.provider,
        endpoint: e.endpoint,
        requestFingerprint: e.requestFingerprint,
        time: e.time,
        block: e.block,
        rawHash: e.rawHash,
        parserVersion: e.parserVersion,
        mode: e.mode,
        payload: e.payload,
      })),
  };
}

export function evidenceHash(evidence: EvidenceRecord[]): Bytes32 {
  return hashCanonical(canonicalEvidenceList(evidence));
}

/** 任务请求哈希（规范化意图 + 展开后的参数）。 */
export function requestHash(job: NormalizedJob): Bytes32 {
  return hashCanonical({
    version: REQUEST_HASH_VERSION,
    clientRequestId: job.clientRequestId,
    ownerAddress: job.ownerAddress,
    recipientAddress: job.recipientAddress,
    executionChainId: job.executionChainId,
    inputAssetKey: job.inputAssetKey,
    outputAssetKey: job.outputAssetKey,
    amountInRaw: job.amountInRaw,
    mode: job.mode,
    policyId: job.policyId,
    policyVersion: job.policyVersion,
    params: job.params,
    // v2：只有 sell 才纳入，buy 的 requestHash 与 v1 完全一致
    ...(job.side === "sell" ? { side: "sell" } : {}),
  });
}

export interface BuildReportInput {
  jobId: string;
  reportVersion: number;
  job: NormalizedJob;
  policy: EffectivePolicy;
  registry: AssetRegistry;
  evidence: EvidenceRecord[];
  evaluatedAt: string;
  calendar?: MarketCalendar;
}

export function buildReport(input: BuildReportInput): VerifyReport {
  const r = evaluateVerification(input);
  return {
    schemaVersion: "1",
    jobId: input.jobId,
    reportVersion: input.reportVersion,
    requestHash: requestHash(input.job),
    policyDefinitionHash: input.policy.policyDefinitionHash,
    effectivePolicyHash: input.policy.effectivePolicyHash,
    registryHash: r.registryHash,
    evaluatedAt: input.evaluatedAt,
    verdict: r.verdict,
    executionEligible: r.executionEligible,
    comparisonStatus: r.comparisonStatus,
    marketSession: r.marketSession,
    reasons: r.reasons,
    normalizedQuote: r.normalizedQuote,
    reference: r.reference,
    evidenceIds: r.evidenceIds,
    evidenceHash: evidenceHash(input.evidence),
    policySnapshot: { definition: input.policy.definition, params: input.policy.params },
  };
}

/** 报告的确定性摘要（用于不可变存储校验；不含自然语言）。 */
export function reportHash(report: VerifyReport): Bytes32 {
  return hashCanonical(report);
}
