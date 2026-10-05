/**
 * 任务证据包的附加复算（K-10 / T-05）：在 v5 `verifyBundleOffline` 之外，验证器还能：
 *  1. 由包内 `conditions` 复算 conditionsHash；绑定哈希（effectivePolicy.params.conditionsHash）与 task.scope 复算的 scopeHash 比对（CV-D16；旧任务比对 conditionsHash），
 *     且签名的硬约束必须都在被求值的条件集里；
 *  2. 用保存的求值输入（evidence / taskState / now）重跑 evaluateConditions，比对 perItem 哈希（同输入同结果，K-01）；
 *  3. 理由卡在包内且 taskId 一致。
 * 包形态 = EvidenceBundle（冻结类型，结构扩展；不改 contracts.ts）+ 任务附加段。
 */
import { hashCanonical } from "../canonical";
import { verifyBundleOffline, type BundleCheck, type TypedDataLike, type VerifyBundleOptions } from "../bundle";
import type { AgentRunSummary, Bytes32, ConditionEvaluation, ConditionSet, EvidenceBundle, EvmAddress, Hex, IsoUtc, MandateStep, MandateStepRecord, StepCertificate, ThesisCard, Task, TradeMandate } from "../contracts";
import { EIP712_TYPES_V2, makePlanGuardDomain, mandateDigest, stepDigest } from "../eip712";
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
  /** 任务时间线（状态、授权、轮次、agent 状态、意图、条件与简报修订）。v2 = timeline_json 缓存（≤ 200 条）；v3 = verify_task_timeline 全部行（带 id / actor / data） */
  timeline?: TaskTimelineEntry[];
  /* ---- v7 CV-D18：任务证据包 v3（多授权 + permit + 轮次哈希链 + 时间线摘要）；缺 bundleVersion 的包按 v2 验证 ---- */
  bundleVersion?: typeof TASK_BUNDLE_V3;
  /** 本任务全部授权（买 + 各卖），每份带全部步骤与证书（含 SUPERSEDED） */
  mandates?: TaskMandateSegment[];
  /** 本任务的 permit 记录（EIP-2612 typedData + owner 签名 + 上链结果） */
  permits?: TaskPermitRecord[];
  /** Agent 轮次摘要（不含完整模型消息） */
  agentRuns?: AgentRunSummary[];
  /** 时间线摘要：hashCanonical({ v: "timeline/1", rows: timeline }) 与条数 */
  timelineDigest?: { v: "timeline/1"; count: number; hash: Bytes32 };
}

export const TASK_BUNDLE_V3 = "task/3" as const;

export interface TaskTimelineEntry {
  at: IsoUtc;
  type: string;
  from?: string;
  to?: string;
  note?: string;
  ref?: string;
  /** v3：verify_task_timeline.id（单调递增） */
  id?: number;
  /** v3：Actor */
  actor?: string;
  /** v3：data_json（只有字符串 / 安全整数 / 布尔） */
  data?: Record<string, unknown> | null;
}

/** 一份授权在任务包里的段（结构与 v5 `EvidenceBundle.mandate` 相同，外加 id / 方向 / 证书与执行） */
export interface TaskMandateSegment {
  mandateId: string;
  side: "buy" | "sell";
  assetKey: string | null;
  state: string;
  typedData: unknown;
  signature: Hex;
  steps: MandateStepRecord[];
  certificates: EvidenceBundle["certificates"];
  executions: EvidenceBundle["executions"];
}

export interface TaskPermitRecord {
  id: string;
  itemId: string | null;
  owner: EvmAddress;
  token: EvmAddress;
  spender: EvmAddress;
  value: string;
  nonce: string;
  deadline: string;
  typedData: unknown;
  signature: Hex | null;
  purpose: string;
  state: string;
  txHash: Hex | null;
  allowanceAfter: string | null;
}

/** §2.6 冻结公式：runHash = hashCanonical({ v: "agent-run/1", prevRunHash, taskId, turnVersion, attempt, model, promptHash, toolCalls, action, decisionSummary, nextCheckAt }) */
export function agentRunHash(r: Pick<AgentRunSummary, "prevRunHash" | "taskId" | "turnVersion" | "attempt" | "model" | "promptHash" | "toolCalls" | "action" | "decisionSummary" | "nextCheckAt">): Bytes32 {
  return hashCanonical({ v: "agent-run/1", prevRunHash: r.prevRunHash, taskId: r.taskId, turnVersion: r.turnVersion, attempt: r.attempt, model: r.model, promptHash: r.promptHash, toolCalls: r.toolCalls, action: r.action, decisionSummary: r.decisionSummary, nextCheckAt: r.nextCheckAt });
}
/** 哈希链只覆盖带动作的轮次（COMPLETED / INCOMPLETE），按完成时间串接（同刻按 turnVersion） */
export function chainedRuns(runs: AgentRunSummary[]): AgentRunSummary[] {
  return runs.filter((r) => r.state === "COMPLETED" || r.state === "INCOMPLETE").sort((a, b) => (a.endedAt ?? "").localeCompare(b.endedAt ?? "") || a.turnVersion - b.turnVersion);
}
export function timelineDigest(rows: TaskTimelineEntry[]): { v: "timeline/1"; count: number; hash: Bytes32 } {
  return { v: "timeline/1", count: rows.length, hash: hashCanonical({ v: "timeline/1", rows }) };
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
    // v3：步骤可能在任一授权（买 / 卖）里——按 (mandateId, stepIndex) 匹配
    const v3Steps = new Set((bundle.mandates ?? []).flatMap((m) => m.steps.map((st) => `${m.mandateId}:${Number(st.stepIndex)}`)));
    const missing = certified.filter((i) => !stepIdx.has(i.step!.stepIndex) && !v3Steps.has(`${i.step!.mandateId}:${i.step!.stepIndex}`));
    const anyCert = bundle.certificates.length > 0 || (bundle.mandates ?? []).some((m) => m.certificates.length > 0);
    add("certified_intents_have_certificates", missing.length === 0 && (certified.length === 0 || anyCert), missing.length ? `certified intent(s) without a matching step in the bundle: ${missing.map((i) => i.id).join(", ")}` : certified.length && !anyCert ? "certified intent(s) but no certificate in the bundle" : `${certified.length} certified intent(s) matched to bundle steps`);
    const bad = bundle.agentIntents.filter((i) => i.status === "certified" && i.checks.some((c) => !c.ok));
    add("certified_intents_passed_all_checks", bad.length === 0, bad.length ? `certified intent(s) with a failed check: ${bad.map((i) => i.id).join(", ")}` : "every certified intent passed facts / scope / execution / binding");
  }
  if (bundle.brief) {
    const versions = bundle.brief.strategyHistory.map((v) => v.version);
    const contiguous = versions.every((v, i) => v === i + 1) && (bundle.brief.strategy === null || bundle.brief.strategy.version === versions.length);
    add("strategy_versions_contiguous", contiguous, contiguous ? `${versions.length} strategy version(s)` : `strategy versions are not contiguous: ${versions.join(",")}`);
  }
  add("task_conditions_match", bundle.task.conditions.hash === bundle.conditions.hash, "task.conditions.hash == bundle.conditions.hash");
  if (bundle.bundleVersion === TASK_BUNDLE_V3) checks.push(...verifyTaskBundleV3(bundle));
  return checks;
}

const lc = (v: unknown) => String(v ?? "").toLowerCase();
function isTypedLike(x: unknown): x is TypedDataLike {
  return typeof x === "object" && x !== null && "domain" in x && "primaryType" in x && "message" in x;
}
function bigOrNull(v: unknown): bigint | null {
  try {
    return BigInt(String(v));
  } catch {
    return null;
  }
}

/**
 * v3 纯检查（不需要验签器）：每份授权摘要与步骤摘要、每步证书绑定、成交归因、permit 记录一致、轮次哈希链与动作可追溯、时间线摘要。
 * 签名类检查（授权签名、证书签名、permit 签名恢复 owner）在 `verifyTaskBundleSignatures`。
 */
export function verifyTaskBundleV3(bundle: TaskEvidenceBundle): BundleCheck[] {
  const checks: BundleCheck[] = [];
  const add = (id: string, ok: boolean, detail: string) => checks.push({ id, ok, detail });
  const chainId = bundle.chainId;
  const mandates = bundle.mandates ?? [];
  const baseDigest = isTypedLike(bundle.mandate?.typedData) ? lc(bundle.mandate.signature) : null;
  if (baseDigest) add("v3_base_mandate_included", mandates.some((m) => lc(m.signature) === baseDigest), "the v2 `mandate` section is one of the bundled mandates");
  for (const m of mandates) {
    const p = `mandate_${m.mandateId}`;
    if (!isTypedLike(m.typedData)) {
      add(`${p}_shape`, false, "typedData not EIP-712 shaped");
      continue;
    }
    const mandate = m.typedData.message as unknown as TradeMandate;
    const domain = makePlanGuardDomain(chainId, m.typedData.domain.verifyingContract);
    let digest: Bytes32 | null = null;
    try {
      digest = mandateDigest(domain, mandate);
    } catch (e) {
      add(`${p}_digest`, false, `digest threw: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!digest) continue;
    const allMatch = m.steps.every((s) => lc(s.step.mandateDigest) === lc(digest));
    add(`${p}_digest`, allMatch, allMatch ? `${m.side} ${digest}` : `a step references a different mandateDigest than ${digest}`);
    m.steps.forEach((s, i) => {
      const sp = `${p}_step_${s.stepIndex}_${i}`;
      let sd: Bytes32;
      try {
        sd = stepDigest(domain, s.step as MandateStep);
      } catch (e) {
        add(`${sp}_digest`, false, `step digest threw: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      add(`${sp}_digest`, lc(sd) === lc(s.stepDigest), lc(sd) === lc(s.stepDigest) ? `${sd} (${s.state})` : `recomputed ${sd} != ${s.stepDigest}`);
      const c = s.certificate as StepCertificate | null;
      if (c) {
        const bound = lc(c.stepDigest) === lc(sd) && lc(c.effectivePolicyHash) === lc(mandate.effectivePolicyHash) && lc(c.policyDefinitionHash) === lc(mandate.policyDefinitionHash) && lc(c.evidenceHash) === lc(s.step.evidenceHash);
        add(`${sp}_cert_binding`, bound, bound ? "certificate binds this step, the mandate's policy hashes and the step evidence hash" : "certificate fields do not match the step / mandate (stepDigest, effectivePolicyHash, policyDefinitionHash, evidenceHash)");
      }
      // 成交归因：回执里的 MandateStep 事件字段 = 这一步（证书）的字段
      const rs = (s.receiptSummary ?? null) as { event?: Record<string, unknown> } | null;
      if (s.state === "CONFIRMED" || rs?.event) {
        const ev = rs?.event;
        if (!ev) add(`${sp}_fill_attribution`, false, "CONFIRMED step without a MandateStep event in receiptSummary");
        else {
          const diffs: string[] = [];
          if (lc(ev["mandateDigest"]) !== lc(s.step.mandateDigest)) diffs.push("mandateDigest");
          if (String(ev["stepIndex"]) !== String(s.step.stepIndex)) diffs.push("stepIndex");
          if (ev["outputToken"] !== undefined && lc(ev["outputToken"]) !== lc(s.step.outputToken)) diffs.push("outputToken");
          if (ev["amountIn"] !== undefined && String(ev["amountIn"]) !== String(s.step.amountIn)) diffs.push("amountIn");
          if (ev["evidenceHash"] !== undefined && lc(ev["evidenceHash"]) !== lc(s.step.evidenceHash)) diffs.push("evidenceHash");
          if (ev["owner"] !== undefined && lc(ev["owner"]) !== lc(mandate.owner)) diffs.push("owner");
          const received = bigOrNull(ev["received"]);
          const minOut = bigOrNull(s.step.minAmountOut);
          if (ev["received"] !== undefined && (received === null || minOut === null || received < minOut)) diffs.push("received<minAmountOut");
          add(`${sp}_fill_attribution`, diffs.length === 0, diffs.length ? `event fields differ from the step: ${diffs.join(", ")}` : "MandateStep event fields equal the certified step");
        }
      }
    });
  }
  // permit 记录：typedData 与记录字段一致（签名恢复在 verifyTaskBundleSignatures）
  for (const pr of bundle.permits ?? []) {
    const td = isTypedLike(pr.typedData) ? pr.typedData : null;
    const msg = td ? (td.message as Record<string, unknown>) : null;
    const same = !!td && !!msg && lc(msg["owner"]) === lc(pr.owner) && lc(msg["spender"]) === lc(pr.spender) && String(msg["value"]) === String(pr.value) && String(msg["nonce"]) === String(pr.nonce) && String(msg["deadline"]) === String(pr.deadline) && lc(td.domain.verifyingContract) === lc(pr.token);
    add(`permit_${pr.id}_fields`, same, same ? `${pr.state}: value ${pr.value} → spender ${pr.spender}` : "permit typedData does not match the recorded owner / spender / value / nonce / deadline / token");
  }
  // 轮次哈希链：连续 + 每轮 runHash 可复算 + 动作能在意图 / 状态记录里找到
  const runs = bundle.agentRuns ?? [];
  const chain = chainedRuns(runs);
  let prev: Bytes32 | null = null;
  const chainDetail: string[] = [];
  for (const r of chain) {
    const again = agentRunHash(r);
    if (lc(r.prevRunHash ?? "") !== lc(prev ?? "")) chainDetail.push(`turn ${r.turnVersion}: prevRunHash ${r.prevRunHash} != ${prev}`);
    if (lc(again) !== lc(r.runHash)) chainDetail.push(`turn ${r.turnVersion}: runHash recomputes to ${again}`);
    prev = r.runHash;
  }
  if (runs.length) add("run_hash_chain", chainDetail.length === 0, chainDetail.length === 0 ? `${chain.length} chained run(s); head ${prev ?? "none"}` : chainDetail.join("; "));
  const intentIds = new Set((bundle.agentIntents ?? []).map((i) => i.id));
  const tl = bundle.timeline ?? [];
  for (const r of chain) {
    if (!r.action) {
      add(`run_${r.turnVersion}_action_recorded`, r.state === "INCOMPLETE", r.state === "INCOMPLETE" ? "incomplete run without an action" : "completed run without an action");
      continue;
    }
    const a = r.action;
    const found = a.kind === "intent" ? intentIds.has(a.ref) : tl.some((e) => e.type.startsWith("agent_") && (e.ref === a.ref || e.data?.["turnVersion"] === r.turnVersion || e.data?.["clientRequestId"] === a.ref));
    add(`run_${r.turnVersion}_action_recorded`, found, found ? `${a.kind} ${a.ref} found in ${a.kind === "intent" ? "agentIntents" : "timeline status records"}` : `${a.kind} ${a.ref} not found in the bundle`);
  }
  // 时间线摘要可复算；行按 id 严格递增且每行有 actor
  if (bundle.timelineDigest) {
    const d = timelineDigest(tl);
    const ok = d.hash === bundle.timelineDigest.hash && d.count === bundle.timelineDigest.count;
    add("timeline_digest", ok, ok ? `${d.count} row(s) ${d.hash}` : `recomputed ${d.count} row(s) ${d.hash} != ${bundle.timelineDigest.count} ${bundle.timelineDigest.hash}`);
    const ids = tl.map((e) => e.id ?? -1);
    const ordered = ids.every((v, i) => v > 0 && (i === 0 || v > ids[i - 1]!)) && tl.every((e) => typeof e.actor === "string" && e.actor.length > 0);
    add("timeline_rows_ordered", ordered, ordered ? "row ids strictly increasing; every row has an actor" : "timeline rows are not in id order or lack an id / actor");
  } else add("timeline_digest", false, "v3 bundle without timelineDigest");
  return checks;
}

/**
 * v3 签名检查（需注入验签器，缺省记 skipped）：每份授权的 owner 签名、每张步骤证书的证明签名、每个 permit 签名恢复 = owner。
 */
export async function verifyTaskBundleSignatures(bundle: TaskEvidenceBundle, opts: VerifyBundleOptions = {}): Promise<BundleCheck[]> {
  const checks: BundleCheck[] = [];
  if (bundle.bundleVersion !== TASK_BUNDLE_V3) return checks;
  const signer = opts.expectedSigner ?? bundle.attestationSigner ?? null;
  const sig = async (id: string, address: `0x${string}`, typedData: TypedDataLike, signature: Hex | null): Promise<void> => {
    if (!signature) {
      checks.push({ id, ok: true, detail: "not verified: no signature recorded", skipped: true });
      return;
    }
    if (!opts.verifyTypedData) {
      checks.push({ id, ok: true, detail: "not verified: no verifier injected", skipped: true });
      return;
    }
    try {
      const ok = await opts.verifyTypedData({ address, typedData, signature });
      checks.push({ id, ok, detail: ok ? `signed by ${address}` : `not signed by ${address}` });
    } catch (e) {
      checks.push({ id, ok: false, detail: `verifier threw: ${e instanceof Error ? e.message : String(e)}` });
    }
  };
  for (const m of bundle.mandates ?? []) {
    if (!isTypedLike(m.typedData)) continue;
    const owner = (m.typedData.message as { owner?: `0x${string}` }).owner;
    if (owner) await sig(`mandate_${m.mandateId}_signature`, owner, m.typedData, m.signature);
    const domain = makePlanGuardDomain(bundle.chainId, m.typedData.domain.verifyingContract);
    for (const [i, s] of m.steps.entries()) {
      if (!s.certificate || !signer) continue;
      const td: TypedDataLike = { domain: { ...domain }, types: { StepCertificate: [...EIP712_TYPES_V2.StepCertificate] }, primaryType: "StepCertificate", message: s.certificate as unknown as Record<string, unknown> };
      await sig(`mandate_${m.mandateId}_step_${s.stepIndex}_${i}_cert_signature`, signer, td, s.certificateSignature);
    }
  }
  for (const pr of bundle.permits ?? []) {
    if (!isTypedLike(pr.typedData)) continue;
    await sig(`permit_${pr.id}_signature`, pr.owner, pr.typedData, pr.signature);
  }
  return checks;
}

export function isTaskBundle(b: unknown): b is TaskEvidenceBundle {
  return typeof b === "object" && b !== null && "task" in b && "conditions" in b && "conditionEvaluations" in b;
}

/**
 * 统一入口（CLI 与 /verify-bundle 页面共用，同一份包结论一致，R-05）：v5 `verifyBundleOffline` + 任务附加复算 + v3 签名检查。
 * 单笔核验包 / 授权计划包只跑第一部分；v2 任务包跑前两部分；v3 任务包三部分都跑。
 */
export async function verifyEvidenceBundle(bundle: EvidenceBundle, opts: VerifyBundleOptions = {}): Promise<BundleCheck[]> {
  const checks = await verifyBundleOffline(bundle, opts);
  if (isTaskBundle(bundle)) {
    try {
      checks.push(...verifyTaskBundleExtras(bundle));
    } catch (e) {
      checks.push({ id: "task_extras", ok: false, detail: `task checks threw: ${e instanceof Error ? e.message : String(e)}` });
    }
    checks.push(...(await verifyTaskBundleSignatures(bundle, opts)));
  }
  return checks;
}
