/**
 * 任务证据包（T-05 / K-10）：v5 授权计划证据包（buildMandateBundle）+ 任务附加段（task / conditions / conditionEvaluations / thesis / 上下文与事件证据），
 * 整体重新计算 bundleHash 并由证明私钥签名——EvidenceBundle 是冻结类型，这里做结构扩展（TaskEvidenceBundle），不改 contracts.ts。
 * 离线验证：core `verifyBundleOffline`（哈希覆盖全部键，附加段自动进哈希）+ `verifyTaskBundleExtras`（conditionsHash 复算、求值重放、理由卡在包内）。
 * SIMULATION 任务 / 尚未授权的任务：没有 mandate，包用 `kind:"mandate"` 之外的最小形态（reports 空、certificates 空），仍带任务附加段。
 */
import { bundleHash as computeBundleHash, type EvidenceBundle, type EvidenceRecord, type TaskEvidenceBundle, type ConditionEvaluationRecord, type ConditionSet, type EffectivePolicy, type PlanGoal } from "@chaconne/core/verify";
import { buildMandateBundle, type BundleDeps } from "../bundle/bundle";
import { HttpError } from "../jobs/service";
import type { TasksService } from "./service";
import type { ThesesService } from "../theses/service";
import { policyWithConditions } from "../mandates/service";
import { findPolicy, resolveParams, registryHash } from "@chaconne/core/verify";

export interface TaskBundleDeps extends BundleDeps {
  tasks: TasksService;
  theses: ThesesService;
}

export async function buildTaskBundle(d: TaskBundleDeps, callerId: string, taskId: string): Promise<TaskEvidenceBundle> {
  if (!d.signer) throw new HttpError(503, "attestation_disabled");
  const row = await d.tasks.requireTask(callerId, taskId);
  const presence = row.mandateIds.length ? "awaiting_signature" : "offline";
  const task = d.tasks.taskOf(row, presence);
  const conditions = row.conditionsJson as ConditionSet;
  const history = await d.tasks.blockerHistory(taskId, 200);
  const conditionEvaluations: ConditionEvaluationRecord[] = history.reverse().map((h) => h.evaluationJson as ConditionEvaluationRecord);
  const thesisRow = row.thesisId ? await d.theses.byId(row.thesisId) : null;
  const thesis = thesisRow ? d.theses.card(thesisRow) : null;
  // 条件求值用到的上下文快照与事件版本以**内嵌形式**保存在 conditionEvaluations[].input.evidence 里（验证器据此重放）；
  // market_context 证据记录另存 verify_context_snapshots.evidence_json，按 snapshotId 可取。
  const extraEvidence: EvidenceRecord[] = [];
  // 当前条件对应的授权（有则复用 v5 证据包）
  let base: Omit<EvidenceBundle, "bundleHash" | "bundleSignature">;
  const current = [...row.mandateIds].reverse();
  let mandateId: string | null = null;
  for (const id of current) {
    const m = await d.mandates.byId(id);
    if (m && m.conditionsHash === row.conditionsHash) {
      mandateId = m.id;
      break;
    }
  }
  if (mandateId) {
    const mb = await buildMandateBundle(d, callerId, mandateId);
    const { bundleHash: _h, bundleSignature: _s, ...rest } = mb;
    void _h;
    void _s;
    base = rest;
  } else {
    const goal = row.goalJson as PlanGoal;
    const def = findPolicy(goal.policyId, goal.policyVersion)!;
    const resolved = resolveParams(def, { maxSlippageBps: goal.maxSlippageBps, maxPriceImpactBps: goal.maxPriceImpactBps, maxReferenceDeviationBps: goal.policyId === "QUOTE_ONLY" ? null : (goal.maxReferenceDeviationBps ?? null) });
    if (!resolved.ok) throw new HttpError(400, "policy_param_out_of_range");
    const policy: EffectivePolicy = policyWithConditions(def, resolved.params, row.conditionsHash as `0x${string}`);
    base = {
      schemaVersion: "1",
      kind: "mandate",
      id: taskId,
      exportedAt: new Date().toISOString(),
      attestationSigner: d.signer.address,
      attestationEpoch: d.signer.epoch,
      chainId: d.cfg.EXECUTION_CHAIN_ID,
      job: null,
      goal,
      registryVersion: d.registry.version,
      registry: d.registry.entries,
      registryHash: registryHash(d.registry),
      policy: def,
      effectivePolicy: policy,
      evidence: [],
      reports: [],
      certificates: [],
      executions: [],
      bill: { serviceFees: [], principal: [], gas: [], selfPayment: false },
    };
  }
  const merged = { ...base, id: taskId, evidence: [...base.evidence, ...extraEvidence], task, conditions, conditionEvaluations, thesis };
  const h = computeBundleHash(merged);
  return { ...merged, bundleHash: h, bundleSignature: await d.signer.signBundleHash(h) };
}
