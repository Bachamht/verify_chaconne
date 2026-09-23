/**
 * 对照里的规划器：用**快照里的同一 quote 证据**跑现有 core 规划器（buildLadder → buildPlanReport），不重新取价。
 * 快照只含该任务上次评估的报价（一个金额），阶梯里其它金额没有报价 → 那些候选 QUOTE_UNAVAILABLE，这是如实结果。
 */
import { buildLadder, buildPlanReport, type AssetRegistry, type EvidenceRecord, type EvidenceSnapshot, type PlanEvidenceSet, type PlanGoal, type PlannerSummary } from "@chaconne/core/verify";

const CLASSIC_KINDS = new Set(["okx_quote", "okx_rwa_token", "pyth_reference", "ref_close", "stablecoin_usd", "token_meta", "registry_lookup"]);

export function plannerFromSnapshot(goal: PlanGoal, registry: AssetRegistry, snapshot: EvidenceSnapshot): PlannerSummary | null {
  try {
    const specs = buildLadder(goal, registry);
    const shared: EvidenceRecord[] = snapshot.records.filter((r) => r.payload.kind !== "okx_quote" && CLASSIC_KINDS.has(r.payload.kind));
    const quotesAll = snapshot.records.filter((r) => r.payload.kind === "okx_quote");
    const quotes: PlanEvidenceSet["quotes"] = {};
    for (const s of specs) {
      const inEntry = registry.entries.find((e) => e.assetKey === s.inputAssetKey);
      const outEntry = registry.entries.find((e) => e.assetKey === s.outputAssetKey);
      const q = quotesAll.find((r) => r.payload.kind === "okx_quote" && r.payload.amountInRaw === s.amountInRaw && (!inEntry || r.payload.fromToken.toLowerCase() === inEntry.tokenAddress.toLowerCase()) && (!outEntry || r.payload.toToken.toLowerCase() === outEntry.tokenAddress.toLowerCase()));
      quotes[s.candidateId] = q ?? null;
    }
    const report = buildPlanReport({ planId: `cmp:${snapshot.id}`, goal, registry, specs, evidence: { shared, quotes }, evaluatedAt: snapshot.takenAt });
    const rec = report.candidates.find((c) => c.candidateId === report.recommended) ?? null;
    const first = report.candidates[0];
    return {
      planHash: report.planHash,
      recommended: report.recommended,
      verdict: rec ? rec.chosenPolicyVerdict : null,
      candidateCount: report.candidates.length,
      blocking: first ? [...new Set(first.reasons.filter((r) => r.severity === "block").map((r) => r.code))] : [],
    };
  } catch {
    return null;
  }
}
