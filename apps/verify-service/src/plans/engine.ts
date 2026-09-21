/**
 * 规划引擎（W1）：core 纯函数（buildLadder → 取报价 → buildPlanReport）+ 服务侧注入的报价获取。
 *  - `quoteLadder`：按候选清单取报价证据集合（PlanEvidenceSet）。默认实现用现有 EvidenceProvider.collect 逐候选取证据
 *    （共享证据取自首个候选，okx_quote 逐候选）；Lane B2 的 `evidence/live.ts quoteLadder(goal)`（并发 ≤ 4）落地后由 I2 注入替换。
 *  - FIXTURE 模式下同样走此路径（FixtureEvidenceProvider 逐候选），测试无需改。
 */
import { buildLadder, buildPlanReport, candidateJob, findPolicy, latestPolicy, buildEffectivePolicy, resolveParams, type AssetRegistry, type EffectivePolicy, type EvidenceRecord, type PlanCandidateSpec, type PlanEvidenceSet, type PlanGoal, type PlanReport } from "@chaconne/core/verify";
import type { EvidenceProvider } from "../evidence/provider";

export interface PlanEngineDeps {
  registry: AssetRegistry;
  evidence: EvidenceProvider;
  nowIso: string;
  planId: string;
}
export interface PlanEngineResult {
  report: PlanReport;
  evidence: EvidenceRecord[];
  policy: EffectivePolicy;
}
export interface PlanEngine {
  plan(goal: PlanGoal, deps: PlanEngineDeps): Promise<PlanEngineResult>;
}

/** 报价获取器：给定候选清单返回 PlanEvidenceSet（B2 注入点） */
export type QuoteLadder = (goal: PlanGoal, specs: PlanCandidateSpec[], deps: PlanEngineDeps) => Promise<PlanEvidenceSet>;

/** 默认：用 EvidenceProvider.collect 逐候选取证据；并发 ≤ 4 */
export const collectQuoteLadder: QuoteLadder = async (goal, specs, deps) => {
  const shared: EvidenceRecord[] = [];
  const quotes: PlanEvidenceSet["quotes"] = {};
  const seenShared = new Set<string>();
  let idx = 0;
  const worker = async () => {
    while (idx < specs.length) {
      const spec = specs[idx++]!;
      const job = candidateJob(goal, spec, goal.policyId, `${deps.planId}:${spec.candidateId}`);
      if (!job) {
        quotes[spec.candidateId] = null;
        continue;
      }
      try {
        const c = await deps.evidence.collect(job, deps.registry, deps.nowIso);
        let quote: EvidenceRecord | null = null;
        for (const e of c.evidence) {
          if (e.payload.kind === "okx_quote") {
            if (!quote) quote = e;
          } else {
            // 共享证据按 (kind, 主体) 去重，保留首次
            const key = `${e.payload.kind}:${"tokenAddress" in e.payload ? e.payload.tokenAddress : "underlyingId" in e.payload ? e.payload.underlyingId : ""}`;
            if (!seenShared.has(key)) {
              seenShared.add(key);
              shared.push(e);
            }
          }
        }
        quotes[spec.candidateId] = quote;
      } catch {
        quotes[spec.candidateId] = null;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, specs.length) }, worker));
  return { shared, quotes };
};

/**
 * 规划的评估时刻必须取在采证**之后**：报价阶梯串行取证要数秒（实测 10 候选 ≈ 5.2 s），
 * 沿用采证前的 nowIso 会让后到的证据（往往是每个候选共用的参考价）receivedAt 超出
 * futureSkewToleranceSeconds(5 s) → 全部候选 SOURCE_TIME_FUTURE，连 QUOTE_ONLY 都被拒。
 * 取「nowIso 与全部证据 receivedAt 的最大值」：无需注入时钟、可离线复算；
 * 阶梯总时长远小于 quoteMaxAgeSeconds(30 s)，不会反过来把早到的报价判过期。
 */
export function evaluatedAfter(nowIso: string, evidence: PlanEvidenceSet): string {
  let latest = Date.parse(nowIso);
  for (const e of [...evidence.shared, ...Object.values(evidence.quotes)]) {
    const t = e ? Date.parse(e.time.receivedAt) : NaN;
    if (Number.isFinite(t) && t > latest) latest = t;
  }
  return new Date(latest).toISOString();
}

export class CorePlanEngine implements PlanEngine {
  constructor(private readonly quoteLadder: QuoteLadder = collectQuoteLadder) {}

  async plan(goal: PlanGoal, deps: PlanEngineDeps): Promise<PlanEngineResult> {
    const specs = buildLadder(goal, deps.registry);
    const evidence = await this.quoteLadder(goal, specs, deps);
    const report = buildPlanReport({ planId: deps.planId, goal, registry: deps.registry, specs, evidence, evaluatedAt: evaluatedAfter(deps.nowIso, evidence) });
    const def = findPolicy(goal.policyId, goal.policyVersion) ?? latestPolicy(goal.policyId);
    const resolved = resolveParams(def, { maxSlippageBps: goal.maxSlippageBps, maxPriceImpactBps: goal.maxPriceImpactBps, maxReferenceDeviationBps: goal.policyId === "QUOTE_ONLY" ? null : (goal.maxReferenceDeviationBps ?? null) });
    if (!resolved.ok) throw new Error("policy params out of range");
    const policy = buildEffectivePolicy(def, resolved.params);
    const all: EvidenceRecord[] = [...evidence.shared, ...Object.values(evidence.quotes).filter((q): q is EvidenceRecord => q !== null)];
    return { report, evidence: all, policy };
  }
}

/* ---------- LIVE：Lane B2 的 quoteLadder（串行 + 间隔，OKX 并发限流） ---------- */
import type { LiveEvidenceProvider } from "../evidence/live";

/** 用 LiveEvidenceProvider.quoteLadder 一次取全部候选报价 + 共享证据 */
export function liveQuoteLadder(live: LiveEvidenceProvider): QuoteLadder {
  return async (goal, specs, deps) => {
    const legs = new Map<string, { legIndex: number; inputAssetKey: string; outputAssetKey: string; amounts: string[] }>();
    for (const s of specs) {
      // 卖出：core spec 的 inputAssetKey 是资金币种、outputAssetKey 是股票；LadderLeg 需要 (输入=股票, 输出=稳定币)
      const inputAssetKey = goal.side === "sell" ? s.outputAssetKey : s.inputAssetKey;
      const outputAssetKey = goal.side === "sell" ? s.inputAssetKey : s.outputAssetKey;
      const key = `${s.legIndex}:${inputAssetKey}:${outputAssetKey}`;
      const leg = legs.get(key) ?? { legIndex: s.legIndex, inputAssetKey, outputAssetKey, amounts: [] };
      leg.amounts.push(s.amountInRaw);
      legs.set(key, leg);
    }
    const r = await live.quoteLadder([...legs.values()], deps.registry, deps.nowIso);
    const byEvidenceId = new Map(r.evidence.map((e) => [e.evidenceId, e]));
    const quotes: PlanEvidenceSet["quotes"] = {};
    for (const s of specs) {
      const inputAssetKey = goal.side === "sell" ? s.outputAssetKey : s.inputAssetKey;
      const outputAssetKey = goal.side === "sell" ? s.inputAssetKey : s.outputAssetKey;
      const q = r.quotes.find((x) => x.legIndex === s.legIndex && x.inputAssetKey === inputAssetKey && x.outputAssetKey === outputAssetKey && x.amountInRaw === s.amountInRaw);
      quotes[s.candidateId] = q?.evidenceId ? (byEvidenceId.get(q.evidenceId) ?? null) : null;
    }
    const quoteIds = new Set(Object.values(quotes).filter((q): q is EvidenceRecord => q !== null).map((q) => q.evidenceId));
    const shared = r.evidence.filter((e) => e.payload.kind !== "okx_quote" || !quoteIds.has(e.evidenceId)).filter((e) => e.payload.kind !== "okx_quote");
    return { shared, quotes };
  };
}
