/**
 * 规划报告组装与哈希（interfaces §10.1）：
 *   goalHash = keccak256(canonical({version:"goal-1", ...goal}))
 *   evidenceHash = 报告同规则（共享证据 + 全部候选报价）
 *   planHash = keccak256(canonical(report 去掉 planHash))
 */
import type { MarketCalendar } from "../../calendar";
import { hashCanonical } from "../canonical";
import type { AssetRegistry, Bytes32, CreateVerifyJob, EvidenceRecord, PlanCandidate, PlanGoal, PlanReport } from "../contracts";
import { buildEffectivePolicy, findPolicy, latestPolicy, resolveParams } from "../policy";
import { registryHash } from "../registry";
import { evidenceHash } from "../report";
import { buildLadder, type LadderOptions } from "./ladder";
import { explainNextStep, scoreCandidate, type ScoredCandidate } from "./score";
import type { PlanCandidateSpec, PlanEvidenceSet } from "./types";

export const GOAL_HASH_VERSION = "goal-1";

export function goalHash(goal: PlanGoal): Bytes32 {
  return hashCanonical({ version: GOAL_HASH_VERSION, ...goal, ladderBps: goal.ladderBps ?? null, maxReferenceDeviationBps: goal.maxReferenceDeviationBps ?? null });
}

export function planEvidenceList(set: PlanEvidenceSet): EvidenceRecord[] {
  return [...set.shared, ...Object.values(set.quotes).filter((q): q is EvidenceRecord => q !== null)];
}

/**
 * `recommended`：仅 eligible；排序 ① completionBps 大者优先 ② legIndex 小者优先（跨腿产出不可比，按腿顺序定序）
 * ③ **同腿同完成度时 expectedOutRaw 大者优先**（同一输出代币，直接可比；例：同为 100% 预算，USDG 比 USDC 多换到股票就推荐 USDG）
 * ④ candidateId 字典序（兜底确定性）。未知产出（null）排在已知之后。
 */
export function chooseRecommended(candidates: PlanCandidate[]): string | null {
  const ok = candidates.filter((c) => c.chosenPolicyVerdict === "eligible");
  if (ok.length === 0) return null;
  const outOf = (c: PlanCandidate): bigint | null => {
    if (c.expectedOutRaw === null) return null;
    try {
      return BigInt(c.expectedOutRaw);
    } catch {
      return null;
    }
  };
  ok.sort((a, b) => {
    if (b.completionBps !== a.completionBps) return b.completionBps - a.completionBps;
    if (a.legIndex !== b.legIndex) return a.legIndex - b.legIndex;
    const oa = outOf(a);
    const ob = outOf(b);
    if (oa !== ob) {
      if (oa === null) return 1;
      if (ob === null) return -1;
      if (ob > oa) return 1;
      if (ob < oa) return -1;
    }
    return a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0;
  });
  return ok[0]!.candidateId;
}

export function planHash(report: Omit<PlanReport, "planHash"> & { planHash?: string }): Bytes32 {
  const { planHash: _omit, ...rest } = report;
  void _omit;
  return hashCanonical(rest);
}

export interface BuildPlanReportInput {
  planId: string;
  goal: PlanGoal;
  registry: AssetRegistry;
  /** 省略则由 buildLadder 生成（必须与取报价时用的一致） */
  specs?: PlanCandidateSpec[];
  evidence: PlanEvidenceSet;
  evaluatedAt: string;
  calendar?: MarketCalendar;
  ladder?: LadderOptions;
}

export function buildPlanReport(input: BuildPlanReportInput): PlanReport {
  const specs = input.specs ?? buildLadder(input.goal, input.registry, input.ladder);
  const scored: ScoredCandidate[] = specs.map((spec) =>
    scoreCandidate({ goal: input.goal, spec, evidence: input.evidence, registry: input.registry, evaluatedAt: input.evaluatedAt, ...(input.calendar ? { calendar: input.calendar } : {}) }),
  );
  const candidates: PlanCandidate[] = scored.map((c) => {
    const peers = scored.filter((p) => p.legIndex === c.legIndex);
    const { blockingCodes: _b, ...pub } = c;
    void _b;
    return { ...pub, nextStep: explainNextStep(c, peers) };
  });
  const def = findPolicy(input.goal.policyId, input.goal.policyVersion) ?? latestPolicy(input.goal.policyId);
  const resolved = resolveParams(def, {
    maxSlippageBps: input.goal.maxSlippageBps,
    maxPriceImpactBps: input.goal.maxPriceImpactBps,
    maxReferenceDeviationBps: input.goal.policyId === "QUOTE_ONLY" ? null : (input.goal.maxReferenceDeviationBps ?? null),
  });
  const policy = resolved.ok ? buildEffectivePolicy(def, resolved.params) : null;
  const body: Omit<PlanReport, "planHash"> = {
    schemaVersion: "1",
    planId: input.planId,
    goalHash: goalHash(input.goal),
    evaluatedAt: input.evaluatedAt,
    registryHash: registryHash(input.registry),
    policyDefinitionHash: policy?.policyDefinitionHash ?? hashCanonical(def),
    effectivePolicyHash: policy?.effectivePolicyHash ?? ("0x" + "0".repeat(64) as Bytes32),
    candidates,
    recommended: chooseRecommended(candidates),
    evidenceHash: evidenceHash(planEvidenceList(input.evidence)),
  };
  return { ...body, planHash: planHash(body) };
}

/** 候选 → 可直接 POST /v1/jobs 的请求（PL-08：同一 requestHash 链由服务侧用同 clientRequestId 保证） */
export function candidateToCreateJob(goal: PlanGoal, candidate: Pick<PlanCandidate, "candidateId" | "legIndex" | "inputAssetKey" | "amountInRaw">, clientRequestId?: string): CreateVerifyJob {
  const leg = goal.legs[candidate.legIndex];
  if (!leg) throw new Error(`legIndex 越界: ${candidate.legIndex}`);
  return {
    clientRequestId: clientRequestId ?? `plan:${candidate.candidateId}`,
    ownerAddress: goal.ownerAddress,
    recipientAddress: goal.recipientAddress,
    executionChainId: goal.executionChainId,
    inputAssetKey: candidate.inputAssetKey,
    outputAssetKey: leg.outputAssetKey,
    amountInRaw: candidate.amountInRaw,
    mode: "exactIn",
    policyId: goal.policyId,
    policyVersion: goal.policyVersion,
    maxSlippageBps: goal.maxSlippageBps,
    maxPriceImpactBps: goal.maxPriceImpactBps,
    maxReferenceDeviationBps: goal.policyId === "QUOTE_ONLY" ? null : (goal.maxReferenceDeviationBps ?? null),
    ...(goal.side === "sell" ? { side: "sell" as const } : {}),
  };
}
