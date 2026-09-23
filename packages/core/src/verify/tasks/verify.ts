/**
 * 任务证据包的附加复算（K-10 / T-05）：在 v5 `verifyBundleOffline` 之外，验证器还能：
 *  1. 由包内 `conditions` 复算 conditionsHash，并与 effectivePolicy.params.conditionsHash（进证书的展开参数）比对；
 *  2. 用保存的求值输入（evidence / taskState / now）重跑 evaluateConditions，比对 perItem 哈希（同输入同结果，K-01）；
 *  3. 理由卡在包内且 taskId 一致。
 * 包形态 = EvidenceBundle（冻结类型，结构扩展；不改 contracts.ts）+ 任务附加段。
 */
import { hashCanonical } from "../canonical";
import type { BundleCheck } from "../bundle";
import type { ConditionEvaluation, ConditionSet, EvidenceBundle, IsoUtc, ThesisCard, Task } from "../contracts";
import { conditionsHash, conditionsHashOfParams, evaluateConditions, type ConditionEvidence, type TaskConditionState } from "../conditions";

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
  const inParams = conditionsHashOfParams(bundle.effectivePolicy.params);
  add("conditions_hash_in_policy_params", inParams === recomputed, inParams ? `effectivePolicy.params.conditionsHash = ${inParams}` : "effectivePolicy.params has no conditionsHash");
  for (const c of bundle.certificates) {
    const msg = (c.typedData as { message?: { effectivePolicyHash?: string } }).message;
    add(`cert_conditions_binding`, msg?.effectivePolicyHash === bundle.effectivePolicy.effectivePolicyHash, "certificate.effectivePolicyHash == bundle.effectivePolicy.effectivePolicyHash (which expands conditionsHash)");
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
  add("task_conditions_match", bundle.task.conditions.hash === bundle.conditions.hash, "task.conditions.hash == bundle.conditions.hash");
  return checks;
}
