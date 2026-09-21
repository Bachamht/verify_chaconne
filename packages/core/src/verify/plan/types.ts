/**
 * 规划引擎（v5 W1）输入形态。引擎是纯函数：报价证据由调用方（Lane B2/C2）事先取得。
 */
import type { EvidenceRecord, PlanGoal } from "../contracts";

/** 一个待报价/待评分的候选（由 buildLadder 确定性生成） */
export interface PlanCandidateSpec {
  candidateId: string;
  legIndex: number;
  inputAssetKey: string;
  outputAssetKey: string;
  amountInRaw: string;
  ladderBps: number;
  weightBps: number;
}

/**
 * 引擎输入：共享证据（参考价、稳定币、代币元数据、registry_lookup、RWA 列表…）+ 每个候选自己的 okx_quote。
 * `quotes[candidateId]` 为 null 表示该候选报价失败（→ QUOTE_UNAVAILABLE）。
 */
export interface PlanEvidenceSet {
  shared: EvidenceRecord[];
  quotes: Record<string, EvidenceRecord | null>;
}

export interface PlanEngineInput {
  planId: string;
  goal: PlanGoal;
  specs: PlanCandidateSpec[];
  evidence: PlanEvidenceSet;
  evaluatedAt: string;
}
