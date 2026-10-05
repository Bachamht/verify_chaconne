/**
 * 任务证据包（T-05 / K-10）：v5 授权计划证据包（buildMandateBundle）+ 任务附加段（task / conditions / conditionEvaluations / thesis / 上下文与事件证据），
 * 整体重新计算 bundleHash 并由证明私钥签名——EvidenceBundle 是冻结类型，这里做结构扩展（TaskEvidenceBundle），不改 contracts.ts。
 * 离线验证：core `verifyBundleOffline`（哈希覆盖全部键，附加段自动进哈希）+ `verifyTaskBundleExtras`（conditionsHash 复算、求值重放、理由卡在包内）。
 * SIMULATION 任务 / 尚未授权的任务：没有 mandate，包用 `kind:"mandate"` 之外的最小形态（reports 空、certificates 空），仍带任务附加段。
 * v7 CV-D18（证据包 v3，`bundleVersion: "task/3"`）：另带本任务**全部**授权段（买 + 各卖，含 SUPERSEDED 步骤与证书）、permit 记录、
 * 轮次摘要（runHash 链；不含 messages_json）、verify_task_timeline 全部行 + timelineDigest。v2 字段（mandate / certificates / timeline）保留，
 * 旧验证器照旧能跑；v3 检查见 core `verifyTaskBundleV3` / `verifyTaskBundleSignatures`。
 */
import { asc, eq } from "drizzle-orm";
import { verifyMandates, verifyPermits } from "@chaconne/db";
import { bundleHash as computeBundleHash, TASK_BUNDLE_V3, timelineDigest, type EvidenceBundle, type EvidenceRecord, type EvmAddress, type Hex, type TaskEvidenceBundle, type TaskMandateSegment, type TaskPermitRecord, type TaskTimelineEntry, type ConditionEvaluationRecord, type ConditionSet, type EffectivePolicy, type PlanGoal } from "@chaconne/core/verify";
import { buildMandateBundle, mandateSegment, type BundleDeps } from "../bundle/bundle";
import { allTimelineRows, type TimelineRow } from "../records/activity";
import { listRunSummaries } from "../records/runs";
import { canonSafe } from "../records/timeline";

/** 时间线行 → 包内条目（v2 字段 + id / actor / data；data 只含 canon-1 可哈希值） */
export function bundleTimelineEntry(r: TimelineRow): TaskTimelineEntry {
  const data = (canonSafe(r.dataJson ?? null) as Record<string, unknown> | null) ?? null;
  const e: TaskTimelineEntry = { id: r.id, at: r.at.toISOString(), actor: r.actor, type: r.type, data };
  if (r.ref !== null) e.ref = r.ref;
  if (r.note !== null) e.note = r.note;
  if (data && typeof data["from"] === "string") e.from = data["from"];
  if (data && typeof data["to"] === "string") e.to = data["to"];
  return e;
}
import { HttpError } from "../jobs/service";
import { bindingHashOf, type TasksService } from "./service";
import type { ThesesService } from "../theses/service";
import { policyWithConditions } from "../mandates/service";
import { findPolicy, resolveParams, registryHash } from "@chaconne/core/verify";

export interface TaskBundleDeps extends BundleDeps {
  tasks: TasksService;
  theses: ThesesService;
}

export async function buildTaskBundle(d: TaskBundleDeps, callerId: string, taskId: string): Promise<TaskEvidenceBundle> {
  if (!d.signer) throw new HttpError(503, "attestation_disabled");
  const row = await d.tasks.requireTask(callerId, taskId, "read");
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
    if (m && m.conditionsHash === bindingHashOf(row)) {
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
    const policy: EffectivePolicy = policyWithConditions(def, resolved.params, bindingHashOf(row));
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
  // CV-D16 批次 7：agent 的过程也进包（简报 / 轮次 / 意图 / 时间线），bundleHash 覆盖全部键
  const intents = await d.tasks.intents.list(callerId, taskId);
  // v7 CV-D18（v3）：全部授权（买 + 各卖，含 SUPERSEDED 步骤）、permit 记录、轮次摘要（runHash 链）、全量时间线 + 摘要
  const db = d.tasks.deps.db;
  const linked = await db.select({ id: verifyMandates.id }).from(verifyMandates).where(eq(verifyMandates.taskId, taskId)).orderBy(asc(verifyMandates.createdAt));
  const mandateIds = [...new Set([...row.mandateIds, ...linked.map((m) => m.id)])];
  // 任务已按调用方鉴权；授权读取用「代表 owner」的内部调用方（同一钱包经网页 / MCP / key 登记的授权都能读，FIX-174）
  const ownerCaller = `task:${row.ownerAddress}`;
  const mandates: TaskMandateSegment[] = [];
  for (const id of mandateIds) mandates.push(await mandateSegment(d, ownerCaller, id));
  const permits: TaskPermitRecord[] = (await db.select().from(verifyPermits).where(eq(verifyPermits.taskId, taskId)).orderBy(asc(verifyPermits.createdAt))).map((p) => ({ id: p.id, itemId: p.itemId ?? null, owner: p.ownerAddress as EvmAddress, token: p.tokenAddress as EvmAddress, spender: p.spender as EvmAddress, value: p.value, nonce: p.nonce, deadline: p.deadline, typedData: p.typedDataJson, signature: (p.signature as Hex | null) ?? null, purpose: p.purpose, state: p.state, txHash: (p.txHash as Hex | null) ?? null, allowanceAfter: p.allowanceAfter ?? null }));
  const agentRuns = await listRunSummaries(db, taskId);
  const timeline: TaskTimelineEntry[] = (await allTimelineRows(db, taskId)).map(bundleTimelineEntry);
  const merged = { ...base, id: taskId, evidence: [...base.evidence, ...extraEvidence], task, conditions, conditionEvaluations, thesis, brief: (row.briefJson as TaskEvidenceBundle["brief"]) ?? null, agentTurn: (row.agentTurnJson as TaskEvidenceBundle["agentTurn"]) ?? null, agentIntents: intents, timeline, bundleVersion: TASK_BUNDLE_V3, mandates, permits, agentRuns, timelineDigest: timelineDigest(timeline) };
  const h = computeBundleHash(merged);
  return { ...merged, bundleHash: h, bundleSignature: await d.signer.signBundleHash(h) };
}
