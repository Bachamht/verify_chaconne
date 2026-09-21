/**
 * 候选评分：对每个候选在三策略下各跑一次规则引擎（复用 evaluateVerification），选中策略的结果决定 verdict/reasons。
 */
import type { MarketCalendar } from "../../calendar";
import type { AssetRegistry, NormalizedJob, PlanCandidate, PlanGoal, PlanNextStep, PolicyId, Reason, ReasonCode, Verdict } from "../contracts";
import { evaluateVerification } from "../evaluate";
import { buildEffectivePolicy, findPolicy, latestPolicy, resolveParams } from "../policy";
import type { PlanCandidateSpec, PlanEvidenceSet } from "./types";

export const POLICY_IDS_ORDERED: readonly PolicyId[] = ["STRICT_LIVE", "REFERENCE_CONTEXT", "QUOTE_ONLY"];

const WAIT_CODES: ReadonlySet<ReasonCode> = new Set(["MARKET_OUTSIDE_REGULAR", "REFERENCE_STALE", "QUOTE_TOO_OLD", "CLOSE_SESSION_MISMATCH", "REFERENCE_MISSING"]);
const DATA_CODES: ReadonlySet<ReasonCode> = new Set(["SOURCE_TIME_MISSING", "USD_CONVERSION_UNKNOWN", "TOKEN_UNIT_UNVERIFIED", "PRICE_IMPACT_UNKNOWN", "REFERENCE_PROVISIONAL", "SOURCE_CONFLICT"]);
const SWITCH_CODES: ReadonlySet<ReasonCode> = new Set(["ASSET_UNSUPPORTED", "ROUTE_UNSUPPORTED", "QUOTE_UNAVAILABLE", "REGISTRY_MISMATCH", "MIN_OUT_INVALID"]);

/** 候选 → 规范化任务（同 requestHash 规则；clientRequestId 由调用方决定，默认 plan:<candidateId>） */
export function candidateJob(goal: PlanGoal, spec: PlanCandidateSpec, policyId: PolicyId, clientRequestId?: string): NormalizedJob | null {
  const def = findPolicy(policyId, policyId === goal.policyId ? goal.policyVersion : latestPolicy(policyId).version) ?? latestPolicy(policyId);
  const resolved = resolveParams(def, {
    maxSlippageBps: goal.maxSlippageBps,
    maxPriceImpactBps: goal.maxPriceImpactBps,
    maxReferenceDeviationBps: policyId === "QUOTE_ONLY" ? null : (goal.maxReferenceDeviationBps ?? null),
  });
  if (!resolved.ok) return null;
  return {
    clientRequestId: clientRequestId ?? `plan:${spec.candidateId}`,
    ownerAddress: goal.ownerAddress,
    recipientAddress: goal.recipientAddress,
    executionChainId: goal.executionChainId,
    inputAssetKey: spec.inputAssetKey,
    outputAssetKey: spec.outputAssetKey,
    amountInRaw: spec.amountInRaw,
    mode: "exactIn",
    policyId: def.policyId,
    policyVersion: def.version,
    params: resolved.params,
    ...(goal.side === "sell" ? { side: "sell" as const } : {}),
  };
}

export interface ScoredCandidate extends PlanCandidate {
  /** 选中策略下的 block 原因码（含 non-HARD） */
  blockingCodes: ReasonCode[];
}

export function scoreCandidate(args: {
  goal: PlanGoal;
  spec: PlanCandidateSpec;
  evidence: PlanEvidenceSet;
  registry: AssetRegistry;
  evaluatedAt: string;
  calendar?: MarketCalendar;
}): ScoredCandidate {
  const { goal, spec, evidence, registry, evaluatedAt } = args;
  const quote = evidence.quotes[spec.candidateId] ?? null;
  const all = quote ? [...evidence.shared, quote] : evidence.shared;
  const verdictByPolicy = {} as Record<PolicyId, { verdict: Verdict; blocking: ReasonCode[] }>;
  let chosenReasons: Reason[] = [];
  let chosenVerdict: Verdict = "rejected";
  let evidenceIds: string[] = [];
  let expectedOutRaw: string | null = null;
  let adverseImpactBps: number | null = null;
  for (const pid of POLICY_IDS_ORDERED) {
    const job = candidateJob(goal, spec, pid);
    if (!job) {
      verdictByPolicy[pid] = { verdict: "rejected", blocking: ["POLICY_PARAM_OUT_OF_RANGE"] };
      if (pid === goal.policyId) {
        chosenReasons = [{ code: "POLICY_PARAM_OUT_OF_RANGE", severity: "block", evidenceIds: [] }];
        chosenVerdict = "rejected";
      }
      continue;
    }
    const def = findPolicy(pid, job.policyVersion)!;
    const policy = buildEffectivePolicy(def, job.params);
    const r = evaluateVerification({ job, policy, registry, evidence: all, evaluatedAt, ...(args.calendar ? { calendar: args.calendar } : {}) });
    const blocking = r.reasons.filter((x) => x.severity === "block").map((x) => x.code);
    verdictByPolicy[pid] = { verdict: r.verdict, blocking: [...new Set(blocking)].sort() };
    if (pid === goal.policyId) {
      chosenReasons = r.reasons;
      chosenVerdict = r.verdict;
      evidenceIds = r.evidenceIds;
      expectedOutRaw = r.normalizedQuote?.expectedOutRaw ?? null;
      adverseImpactBps = r.normalizedQuote?.adverseImpactBps ?? null;
    }
  }
  return {
    candidateId: spec.candidateId,
    legIndex: spec.legIndex,
    inputAssetKey: spec.inputAssetKey,
    amountInRaw: spec.amountInRaw,
    expectedOutRaw,
    adverseImpactBps,
    feeEstimate: { gasNative: null, routeFeeBps: null },
    completionBps: spec.ladderBps,
    verdictByPolicy,
    chosenPolicyVerdict: chosenVerdict,
    reasons: chosenReasons,
    evidenceIds,
    nextStep: "WAIT_CONDITION", // 由 explainNextStep 在全体候选已知后定稿
    blockingCodes: verdictByPolicy[goal.policyId]?.blocking ?? [],
  };
}

/**
 * 下一步（在同腿全体候选已评分后决定）：
 *  eligible & 100% → READY；eligible & <100% → ACCEPT_PARTIAL；
 *  PRICE_IMPACT_EXCEEDED 阻断且同腿同币种有更小阶梯 eligible → USER_MUST_RELAX_LIMIT；
 *  本币种被 ASSET/ROUTE/QUOTE/REGISTRY 阻断但同腿另一币种有 eligible → SWITCH_INPUT；
 *  时段/时效类阻断 → WAIT_CONDITION；数据缺失类 → PROVIDE_DATA；其余 → USER_MUST_RELAX_LIMIT。
 */
export function explainNextStep(c: ScoredCandidate, legPeers: ScoredCandidate[]): PlanNextStep {
  if (c.chosenPolicyVerdict === "eligible") return c.completionBps >= 10_000 ? "READY" : "ACCEPT_PARTIAL";
  const codes = new Set(c.blockingCodes);
  const sameInputEligible = legPeers.some((p) => p.inputAssetKey === c.inputAssetKey && p.chosenPolicyVerdict === "eligible");
  const otherInputEligible = legPeers.some((p) => p.inputAssetKey !== c.inputAssetKey && p.chosenPolicyVerdict === "eligible");
  if (codes.has("PRICE_IMPACT_EXCEEDED") || codes.has("REFERENCE_DEVIATION_EXCEEDED")) return sameInputEligible ? "USER_MUST_RELAX_LIMIT" : otherInputEligible ? "SWITCH_INPUT" : "USER_MUST_RELAX_LIMIT";
  if ([...codes].some((k) => SWITCH_CODES.has(k))) return otherInputEligible ? "SWITCH_INPUT" : "PROVIDE_DATA";
  if ([...codes].some((k) => WAIT_CODES.has(k))) return "WAIT_CONDITION";
  if ([...codes].some((k) => DATA_CODES.has(k))) return "PROVIDE_DATA";
  return "USER_MUST_RELAX_LIMIT";
}
