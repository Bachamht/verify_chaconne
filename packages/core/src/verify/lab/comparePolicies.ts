/**
 * 同输入对照（C9 · L-02 / L-06）：两套条件在**同一证据快照**上各跑一次求值 +（可选）规划器，输出逐项差异。
 * 纯函数：不写库、不签发、不改真实任务；`mode` 固定 SIMULATION。规划器由调用方注入并用快照里的同一 quote 证据。
 */
import type { ConditionSet, ConditionType, PlanGoal, PolicyComparison, PolicyComparisonVariant, ReasonCode, Verdict } from "../contracts";
import { hashCanonical } from "../canonical";
import type { ConditionEvaluator, ConditionTaskState, EvidenceSnapshot } from "./types";
import { snapshotInput } from "./snapshot";

export interface PlannerSummary {
  planHash: string;
  recommended: string | null;
  /** 推荐候选的结论；无推荐 → null */
  verdict: Verdict | null;
  candidateCount: number;
  /** 首个候选的阻塞码（同 quote 证据下各变体相同才正常） */
  blocking: ReasonCode[];
}

export interface CompareVariantInput {
  label: string;
  conditions: ConditionSet;
}

export interface ComparePoliciesInput {
  taskId: string;
  snapshot: EvidenceSnapshot;
  /** 恰好两套（"双策略对照"） */
  variants: [CompareVariantInput, CompareVariantInput];
  evaluator: ConditionEvaluator;
  taskState: ConditionTaskState;
  /** 规划器（同 quote 证据）；不注入 → planner 结果为 null（如实标注） */
  planner?: (variant: CompareVariantInput) => PlannerSummary | null;
  /** 翻创用的目标（同资产/资金基准/费用假设）；无 → remix.simulationBody 为 null */
  goal: PlanGoal | null;
  /** 对照 id（服务分配）；缺省由内容派生 */
  id?: string;
}

export interface SimulationRemix {
  /** 可直接 POST /v1/simulations 的 body（额外键 labConditions 由 /v1/simulations 忽略、由 /v1/tasks 使用） */
  simulationBody: (Omit<PlanGoal, "deadline"> & { clientRequestId: string; labConditions: ConditionSet; labVariantLabel: string }) | null;
  conditions: ConditionSet;
  variantLabel: string;
  note: { en: string; zh: string };
}

export interface ComparePoliciesResult {
  comparison: PolicyComparison;
  /** 与 variants 同序 */
  planner: Array<{ label: string; summary: PlannerSummary | null }>;
  /** 结论差异摘要（页面直接用） */
  outcomeDiff: Array<{ label: string; outcome: PolicyComparisonVariant["outcome"]; blockingCodes: ReasonCode[]; nextCheckAt: string | null }>;
  /** L-06：任一变体都可翻创为模拟任务；默认给"放行的那套"，都不放行给第一套 */
  remix: SimulationRemix;
  evaluatorId: string;
  mode: "SIMULATION";
}

export function comparePolicies(input: ComparePoliciesInput): ComparePoliciesResult {
  const ev = snapshotInput(input.snapshot);
  const now = input.snapshot.takenAt;
  const variants: PolicyComparisonVariant[] = input.variants.map((v) => {
    const r = input.evaluator.evaluate(v.conditions, ev, input.taskState, now);
    return { label: v.label, conditions: v.conditions, outcome: r.outcome, perItem: r.perItem };
  });
  const [a, b] = input.variants;
  const types = new Set<ConditionType>([...a.conditions.items.map((i) => i.type), ...b.conditions.items.map((i) => i.type)]);
  const diff: PolicyComparison["diff"] = [];
  for (const t of [...types].sort()) {
    const ia = a.conditions.items.filter((i) => i.type === t);
    const ib = b.conditions.items.filter((i) => i.type === t);
    const ja = ia.length === 0 ? null : ia.length === 1 ? ia[0] : ia;
    const jb = ib.length === 0 ? null : ib.length === 1 ? ib[0] : ib;
    if (hashCanonical(ja) !== hashCanonical(jb)) diff.push({ itemType: t, a: ja, b: jb });
  }
  const id = input.id ?? `cmp_${hashCanonical({ taskId: input.taskId, snapshot: input.snapshot.id, a: a.conditions.hash, b: b.conditions.hash }).slice(2, 26)}`;
  const comparison: PolicyComparison = { id, taskId: input.taskId, evidenceSnapshotId: input.snapshot.id, variants, diff, mode: "SIMULATION" };
  const planner = input.variants.map((v) => ({ label: v.label, summary: input.planner ? input.planner(v) : null }));
  const outcomeDiff = variants.map((v) => ({
    label: v.label,
    outcome: v.outcome,
    blockingCodes: [...new Set(v.perItem.filter((p) => p.outcome !== "SATISFIED").flatMap((p) => p.reasons.map((r) => r.code)))],
    nextCheckAt: v.perItem.map((p) => p.nextCheckAt).filter((x): x is string => !!x).sort()[0] ?? null,
  }));
  const pick = variants.find((v) => v.outcome === "SATISFIED") ?? variants[0]!;
  const remix: SimulationRemix = {
    simulationBody: input.goal
      ? (() => {
          const { deadline: _d, ...goal } = input.goal;
          void _d;
          return { ...goal, clientRequestId: `remix-${id}-${pick.label.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 16) || "v"}`, labConditions: pick.conditions, labVariantLabel: pick.label };
        })()
      : null,
    conditions: pick.conditions,
    variantLabel: pick.label,
    note: {
      en: "Remix creates a SIMULATION only: planner and rules run on real evidence; no certificate, no authorization, no execution.",
      zh: "翻创只创建 SIMULATION：规划器与规则跑在真实证据上；不签证书、不写授权、不执行。",
    },
  };
  return { comparison, planner, outcomeDiff, remix, evaluatorId: input.evaluator.id, mode: "SIMULATION" };
}
