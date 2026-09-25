/**
 * 任务证据包的附加复算（K-10 / T-05）：在 v5 `verifyBundleOffline` 之外，验证器还能：
 *  1. 由包内 `conditions` 复算 conditionsHash；绑定哈希（effectivePolicy.params.conditionsHash）与 task.scope 复算的 scopeHash 比对（CV-D16；旧任务比对 conditionsHash），
 *     且签名的硬约束必须都在被求值的条件集里；
 *  2. 用保存的求值输入（evidence / taskState / now）重跑 evaluateConditions，比对 perItem 哈希（同输入同结果，K-01）；
 *  3. 理由卡在包内且 taskId 一致。
 * 包形态 = EvidenceBundle（冻结类型，结构扩展；不改 contracts.ts）+ 任务附加段。
 */
import { hashCanonical } from "../canonical";
import type { BundleCheck } from "../bundle";
import type { ConditionEvaluation, ConditionSet, EvidenceBundle, IsoUtc, ThesisCard, Task } from "../contracts";
import { conditionsHash, conditionsHashOfParams, evaluateConditions, type ConditionEvidence, type TaskConditionState } from "../conditions";
import { scopeHash } from "./scope";

/** 每次条件求值的可复算快照（存 verify_task_blockers.input_json，进证据包） */
export interface ConditionEvaluationRecord {
  input: { set: ConditionSet; evidence: ConditionEvidence; taskState: TaskConditionState; now: IsoUtc };
  output: ConditionEvaluation;
}

export interface TaskBundleExtras {
  task: Task;
  conditions: ConditionSet;
  conditionEvaluations: ConditionEvaluationRecord[];
  thesis: ThesisCard | null;
  /* ---- CV-D16 批次 7：任务级决策记录（Task Decision Bundle）——agent 的过程也进包，bundleHash 一并覆盖 ---- */
  /** 简报：策略全部版本、当前计划、关注事件、接管的 agent */
  brief?: import("./agentTurn").TaskBrief | null;
  /** 当前轮次 */
  agentTurn?: import("./agentTurn").AgentTurn | null;
  /** 全部 agent 交易意图（决策记录、依据分拣、四道核验、计划偏离、签发的步骤）；名字避开 v1 的 `intents`（单笔 TradeIntent 签名） */
  agentIntents?: import("./intents").AgentTradeIntent[];
  /** 任务时间线（状态、授权、轮次、agent 状态、意图、条件与简报修订） */
  timeline?: Array<{ at: IsoUtc; type: string; from?: string; to?: string; note?: string; ref?: string }>;
}
export type TaskEvidenceBundle = EvidenceBundle & TaskBundleExtras;

export function perItemHash(ev: ConditionEvaluation): `0x${string}` {
  return hashCanonical(ev.perItem.map((p) => ({ outcome: p.outcome, reasons: p.reasons, evidenceIds: p.evidenceIds, nextCheckAt: p.nextCheckAt })));
}

export function verifyTaskBundleExtras(bundle: TaskEvidenceBundle): BundleCheck[] {
  const checks: BundleCheck[] = [];
  const add = (id: string, ok: boolean, detail: string) => checks.push({ id, ok, detail });
  const recomputed = conditionsHash(bundle.conditions.items, bundle.conditions.version);
  add("conditions_hash", recomputed === bundle.conditions.hash, recomputed === bundle.conditions.hash ? recomputed : `recomputed ${recomputed} != ${bundle.conditions.hash}`);
  // CV-D16：scope/1 任务的绑定哈希 = scopeHash（由包内 task.scope 复算）；旧任务 = conditionsHash
  const inParams = conditionsHashOfParams(bundle.effectivePolicy.params);
  if (bundle.task.scope) {
    const recomputedScope = scopeHash(bundle.task.scope);
    add("scope_hash", recomputedScope === bundle.task.scopeHash, recomputedScope === bundle.task.scopeHash ? recomputedScope : `recomputed ${recomputedScope} != ${bundle.task.scopeHash}`);
    add("scope_hash_in_policy_params", inParams === recomputedScope, inParams ? `effectivePolicy.params.conditionsHash (binding hash) = ${inParams}` : "effectivePolicy.params has no binding hash");
    const hardTypes = new Set(bundle.task.scope.hardConditions.map((h) => h.type));
    const hardPresent = bundle.task.scope.hardConditions.every((h) => bundle.conditions.items.some((c) => JSON.stringify(c) === JSON.stringify(h)));
    add("hard_conditions_in_set", hardPresent, hardPresent ? `${hardTypes.size} hard condition type(s) present in the evaluated set` : "a signed hard condition is missing from the evaluated condition set");
  } else {
    add("conditions_hash_in_policy_params", inParams === recomputed, inParams ? `effectivePolicy.params.conditionsHash = ${inParams}` : "effectivePolicy.params has no conditionsHash");
  }
  for (const c of bundle.certificates) {
    const msg = (c.typedData as { message?: { effectivePolicyHash?: string } }).message;
    add(`cert_conditions_binding`, msg?.effectivePolicyHash === bundle.effectivePolicy.effectivePolicyHash, "certificate.effectivePolicyHash == bundle.effectivePolicy.effectivePolicyHash (which expands the binding hash: scopeHash for scope/1 tasks, conditionsHash for legacy tasks)");
  }
  bundle.conditionEvaluations.forEach((rec, i) => {
    let ok = false;
    let detail = "";
    try {
      const again = evaluateConditions(rec.input.set, rec.input.evidence, rec.input.taskState, rec.input.now);
      ok = perItemHash(again) === perItemHash(rec.output) && again.outcome === rec.output.outcome && again.conditionsHash === rec.output.conditionsHash;
      detail = ok ? `re-evaluated ${again.outcome} @ ${rec.input.now}` : `re-evaluation differs: ${again.outcome} vs ${rec.output.outcome}`;
    } catch (e) {
      detail = `re-evaluation threw: ${e instanceof Error ? e.message : String(e)}`;
    }
    add(`condition_eval_${i}_replay`, ok, detail);
  });
  add("thesis_present", bundle.thesis !== null && bundle.thesis.taskId === bundle.task.id, bundle.thesis ? `thesis ${bundle.thesis.id} status=${bundle.thesis.status}` : "no thesis card in bundle");
  // 决策记录：意图都属于这个任务；certified 的意图必须指向包内的一张证书（步骤签发有据可查）；策略版本连续
  if (bundle.agentIntents) {
    const foreign = bundle.agentIntents.filter((i) => i.taskId !== bundle.task.id);
    add("intents_belong_to_task", foreign.length === 0, foreign.length ? `${foreign.length} intent(s) belong to another task` : `${bundle.agentIntents.length} intent(s)`);
    const certified = bundle.agentIntents.filter((i) => i.status === "certified" && i.step);
    // 证书本身只带 stepDigest；步骤记录（mandate.steps[]）带 stepIndex——certified 的意图必须能在包内找到同 index 的步骤且包内有证书
    const stepIdx = new Set((bundle.mandate?.steps ?? []).map((st) => Number(st.stepIndex)));
    const missing = certified.filter((i) => !stepIdx.has(i.step!.stepIndex));
    add("certified_intents_have_certificates", missing.length === 0 && (certified.length === 0 || bundle.certificates.length > 0), missing.length ? `certified intent(s) without a matching step in the bundle: ${missing.map((i) => i.id).join(", ")}` : certified.length && bundle.certificates.length === 0 ? "certified intent(s) but no certificate in the bundle" : `${certified.length} certified intent(s) matched to bundle steps`);
    const bad = bundle.agentIntents.filter((i) => i.status === "certified" && i.checks.some((c) => !c.ok));
    add("certified_intents_passed_all_checks", bad.length === 0, bad.length ? `certified intent(s) with a failed check: ${bad.map((i) => i.id).join(", ")}` : "every certified intent passed facts / scope / execution / binding");
  }
  if (bundle.brief) {
    const versions = bundle.brief.strategyHistory.map((v) => v.version);
    const contiguous = versions.every((v, i) => v === i + 1) && (bundle.brief.strategy === null || bundle.brief.strategy.version === versions.length);
    add("strategy_versions_contiguous", contiguous, contiguous ? `${versions.length} strategy version(s)` : `strategy versions are not contiguous: ${versions.join(",")}`);
  }
  add("task_conditions_match", bundle.task.conditions.hash === bundle.conditions.hash, "task.conditions.hash == bundle.conditions.hash");
  return checks;
}
