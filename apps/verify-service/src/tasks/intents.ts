/**
 * agent 交易意图（CV-D16 批次 2）：POST /v1/tasks/:id/intents
 *   意图（买什么 / 多少）+ 决策记录（为什么、依据）→ 四道核验（facts 事实分拣 / scope 授权 / execution 执行核验 / binding 绑定）
 *   → LIVE 全过才签步骤证书并交出 guardCall；SIMULATION 只核验不签；任一道不过 → 422 rejected（决策记录照样保存）。
 * 决策记录不是通行证：它只被分类、标注、存档；硬约束与执行核验永远由平台做。计划条件对意图**不阻塞**，偏离只记为 planDeviations。
 * 签证书 ≠ 发交易：执行仍由 agent 调 execute_next_step / 浏览器钱包完成。
 */
import { and, desc, eq } from "drizzle-orm";
import { verifyMandateSteps, verifyTaskIntents } from "@chaconne/db";
import {
  buildReport,
  evaluateConditions,
  findEntry,
  findPolicy,
  makeConditionSet,
  resolveParams,
  resolveIntentBody,
  triageClaims,
  STOP_SEMANTICS_NOTE,
  TASK_RUNNING_STATUSES,
  type AgentTradeIntent,
  type ClaimTriage,
  type ConditionEvidence,
  type ConditionSet,
  type EvidenceRecord,
  type IntentCheck,
  type IntentStatus,
  type NormalizedJob,
  type PlanGoal,
  type Reason,
  type TaskStatus,
  type VerifyReport,
} from "@chaconne/core/verify";
import { HttpError } from "../jobs/service";
import { newId } from "../ids";
import { log } from "../log";
import { policyWithConditions, type EvaluateGateInput, type MandateRow } from "../mandates/service";
import { notificationPayload } from "./notify";
import { bindingHashOf, scopeOf, SCOPE_BOUNDARY_NOTE, type LastEvaluation, type TaskRow, type TasksDeps, type TasksService, type TimelineEntry } from "./service";

export type IntentRow = typeof verifyTaskIntents.$inferSelect;

export class IntentsService {
  constructor(private readonly tasks: TasksService, private readonly d: TasksDeps, private readonly now: () => Date) {}

  /* ---------------- 读取 ---------------- */

  async byId(id: string): Promise<IntentRow | null> {
    return (await this.d.db.select().from(verifyTaskIntents).where(eq(verifyTaskIntents.id, id)).limit(1))[0] ?? null;
  }
  async list(callerId: string, taskId: string): Promise<AgentTradeIntent[]> {
    await this.tasks.requireTask(callerId, taskId);
    const rows = await this.d.db.select().from(verifyTaskIntents).where(eq(verifyTaskIntents.taskId, taskId)).orderBy(desc(verifyTaskIntents.createdAt)).limit(100);
    return rows.map((r) => this.view(r));
  }
  /** withStep：certified 且步骤仍 PREPARED 未过期 → 附上 READY 体（guardCall 等），供 agent-wallet 执行器再取 */
  async get(callerId: string, taskId: string, intentId: string, withStep = false): Promise<AgentTradeIntent & { ready?: Record<string, unknown> | null }> {
    await this.tasks.requireTask(callerId, taskId);
    const row = await this.byId(intentId);
    if (!row || row.taskId !== taskId) throw new HttpError(404, "intent_not_found");
    const v = this.view(row);
    if (!withStep) return v;
    let ready: Record<string, unknown> | null = null;
    if (v.status === "certified" && v.step) {
      const mandate = await this.d.mandates.byId(v.step.mandateId);
      const step = (await this.d.mandates.steps(v.step.mandateId)).find((s) => s.stepIndex === v.step!.stepIndex);
      if (mandate && step && step.state === "PREPARED" && step.validUntil.getTime() > this.now().getTime() && step.evaluationId) {
        const evaluation = await this.d.mandates.evaluationById(step.evaluationId);
        if (evaluation) ready = await this.d.mandates.pullStep(mandate, step, evaluation);
      }
    }
    return { ...v, ready };
  }
  view(r: IntentRow): AgentTradeIntent {
    return {
      id: r.id,
      taskId: r.taskId,
      clientRequestId: r.clientRequestId,
      kind: r.kind as AgentTradeIntent["kind"],
      outputAssetKey: r.outputAssetKey,
      amountInRaw: r.amountInRaw,
      decision: r.decisionJson as AgentTradeIntent["decision"],
      triage: r.triageJson as ClaimTriage[],
      checks: r.checksJson as IntentCheck[],
      status: r.status as IntentStatus,
      step: (r.stepJson as AgentTradeIntent["step"]) ?? null,
      planDeviations: r.planDeviationsJson as Reason[],
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  /* ---------------- 提交 ---------------- */

  async submit(callerId: string, taskId: string, raw: unknown): Promise<{ httpStatus: 200 | 201 | 422; body: Record<string, unknown> }> {
    const row = await this.tasks.requireTask(callerId, taskId);
    const parsed = resolveIntentBody(raw);
    if (!parsed.ok) throw new HttpError(400, "invalid_request", "交易意图校验失败", parsed.errors);
    const b = parsed.body;
    const scope = scopeOf(row);
    if (!scope) throw new HttpError(409, "scope_required", "该任务没有授权范围（建于 CV-D16 之前）：请建新任务再提交意图");
    // 幂等
    const existing = (await this.d.db.select().from(verifyTaskIntents).where(and(eq(verifyTaskIntents.taskId, taskId), eq(verifyTaskIntents.clientRequestId, b.clientRequestId))).limit(1))[0];
    if (existing) {
      if (existing.kind !== b.kind || existing.outputAssetKey !== b.outputAssetKey || existing.amountInRaw !== b.amountInRaw) throw new HttpError(409, "idempotency_conflict", "同一 clientRequestId 已绑定不同意图");
      return { httpStatus: 200, body: await this.responseFor(row, existing, null) };
    }
    if (row.status === "PAUSED") throw new HttpError(409, "task_paused", "任务已暂停：暂停期间不按意图签发（D-088）");
    if (!TASK_RUNNING_STATUSES.has(row.status as TaskStatus)) throw new HttpError(409, "task_not_active", `任务状态 ${row.status}${row.status === "AWAITING_AUTHORIZATION" ? "：先签授权（POST /v1/tasks/:id/authorize）" : ""}`);
    if (!this.d.cfg.agentC2) throw new HttpError(503, "agent_c2_disabled", "条件层已关闭（AGENT_C2_ENABLED=false）：不签发");

    const nowDate = this.now();
    const nowIso = nowDate.toISOString();
    const live = row.mode === "LIVE";
    const outEntry = findEntry(this.d.registry, b.outputAssetKey);
    const st = await this.tasks.taskState(row);
    const base = await this.tasks.conditionEvidence(row, st, null);
    const hardSet = makeConditionSet(scope.hardConditions);
    const planSet = row.conditionsJson as ConditionSet;
    const checks: IntentCheck[] = [];
    let planDeviations: Reason[] = [];
    let quoteEvidence: EvidenceRecord[] = [];
    let mandate: MandateRow | null = null;
    let step: { mandateId: string; stepIndex: number; validUntil: string } | null = null;
    let ready: Record<string, unknown> | null = null;

    // ---- 2. scope（不依赖报价的部分）：意图必须在签名范围内 ----
    const scopeReasons: Reason[] = [];
    const oos = (field: string, note: string): Reason => ({ code: "INTENT_OUT_OF_SCOPE", severity: "block", evidenceIds: [], detail: { field, note } });
    if (b.kind === "sell") scopeReasons.push(scope.allowSell ? { code: "SELL_MANDATE_REQUIRED", severity: "block", evidenceIds: [], detail: { note: "sell intents need a per-asset sell authorization; not issued from this endpoint yet" } } : oos("kind", "scope.allowSell is false"));
    if (!outEntry || !scope.outputAssetKeys.includes(b.outputAssetKey)) scopeReasons.push(oos("outputAssetKey", `not in scope.outputAssetKeys [${scope.outputAssetKeys.join(", ")}]`));
    if (BigInt(b.amountInRaw) > BigInt(scope.perStepCapRaw)) scopeReasons.push(oos("amountInRaw", `exceeds scope.perStepCapRaw ${scope.perStepCapRaw}`));
    if (Date.parse(scope.deadline) <= nowDate.getTime()) scopeReasons.push(oos("deadline", "scope.deadline passed"));
    if (live) {
      mandate = await this.tasks.currentMandate(row);
      if (!mandate) scopeReasons.push({ code: "AWAITING_USER_SIGNATURE", severity: "block", evidenceIds: [], detail: { note: "no active authorization for the task's current scope" } });
      else {
        if (mandate.state !== "ACTIVE") scopeReasons.push(oos("mandate", `authorization is ${mandate.state}`));
        const remaining = BigInt(mandate.budgetCap) - BigInt(mandate.spent);
        if (BigInt(b.amountInRaw) > remaining) scopeReasons.push(oos("amountInRaw", `exceeds remaining budget ${remaining}`));
        if (mandate.stepsDone >= mandate.maxSteps) scopeReasons.push(oos("maxSteps", `${mandate.stepsDone}/${mandate.maxSteps} steps done`));
      }
    } else {
      if (row.stepsConfirmed >= scope.maxSteps) scopeReasons.push(oos("maxSteps", `${row.stepsConfirmed}/${scope.maxSteps} steps done`));
    }
    const scopePreOk = scopeReasons.length === 0;
    // ---- 1. facts（可采信性先判：不可采信的依据不进执行核验，避免先签后作废）----
    const preTriage = triageClaims(b.decision, scope.trustTier, new Set());
    const factsOk = preTriage.every((t) => t.admissible);

    // ---- 3. execution（含硬约束闸门与计划偏离记录）----
    let hardReasons: Reason[] = [];
    let execReasons: Reason[] = [];
    let execOk = false;
    let execDetail: Record<string, unknown> = {};
    const gate = async (g: EvaluateGateInput) => {
      const ev: ConditionEvidence = { ...base.evidence, quote: this.tasks.quoteFromReport(g.report) };
      quoteEvidence = g.evidence;
      const hard = hardSet.items.length ? evaluateConditions(hardSet, ev, st, g.nowIso) : null;
      const post = this.tasks.postEarnings(hardSet, base.evidence, g.report, g.nowIso);
      hardReasons = [...(hard ? hard.perItem.flatMap((p) => (p.outcome === "SATISFIED" ? [] : p.reasons)) : []), ...post.reasons];
      // 计划条件：agent 在范围内可以偏离计划，只记录不阻塞（thesis_holds 也只是信息）
      const plan = evaluateConditions(planSet, ev, st, g.nowIso);
      planDeviations = plan.perItem.flatMap((p) => (p.outcome === "SATISFIED" ? [] : p.reasons.map((r) => ({ ...r, severity: "info" as const }))));
      const ok = hardReasons.length === 0;
      return { ok, reasons: ok ? [] : [{ code: "HARD_CONSTRAINT_BLOCK" as const, severity: "block" as const, evidenceIds: hardReasons.flatMap((r) => r.evidenceIds), detail: { codes: [...new Set(hardReasons.map((r) => r.code))].join(",") } }, ...hardReasons], nextCheckAt: hard?.nextCheckAt ?? post.nextCheckAt };
    };
    if (scopePreOk && factsOk) {
      if (live && mandate) {
        const r = await this.d.mandates.issueIntentStep(mandate, { outputAssetKey: b.outputAssetKey, amountIn: BigInt(b.amountInRaw), gate, issue: true });
        execReasons = r.reasons.filter((x) => x.severity === "block");
        execOk = r.status === "READY" && !!r.step;
        execDetail = { status: r.status, verdict: r.report?.verdict ?? null, marketSession: r.report?.marketSession ?? null, evaluationId: r.evaluation.id, reportHash: r.evaluation.reportHash };
        if (r.step) {
          step = { mandateId: mandate.id, stepIndex: r.step.stepIndex, validUntil: r.step.validUntil.toISOString() };
          ready = await this.d.mandates.pullStep(mandate, r.step, r.evaluation);
        }
      } else {
        try {
          const { job, policy } = this.simulationJob(row, b.outputAssetKey, b.amountInRaw);
          const collected = await this.d.evidence.collect(job, this.d.registry, nowIso);
          const report: VerifyReport = buildReport({ jobId: row.id, reportVersion: 1, job, policy, registry: this.d.registry, evidence: collected.evidence, evaluatedAt: nowIso });
          const g = await gate({ report, evidence: collected.evidence, nowIso });
          execReasons = [...report.reasons.filter((x) => x.severity === "block"), ...g.reasons];
          execOk = report.executionEligible && g.ok;
          execDetail = { status: execOk ? "READY" : "WAIT", verdict: report.verdict, marketSession: report.marketSession, simulation: true };
        } catch (err) {
          execReasons = [{ code: "QUOTE_UNAVAILABLE", severity: "block", evidenceIds: [], detail: { error: err instanceof Error ? err.message.slice(0, 200) : String(err) } }];
          execDetail = { status: "WAIT", simulation: !live };
        }
      }
    }
    // scope 的最终结论 = 前置范围检查 + 硬约束
    const hardBlock: Reason[] = hardReasons.length ? [{ code: "HARD_CONSTRAINT_BLOCK", severity: "block", evidenceIds: [], detail: { codes: [...new Set(hardReasons.map((r) => r.code))].join(",") } }, ...hardReasons] : [];
    checks.push({ id: "scope", ok: scopePreOk && hardBlock.length === 0, reasons: [...scopeReasons, ...hardBlock], detail: { outputAssetKeys: scope.outputAssetKeys, perStepCapRaw: scope.perStepCapRaw, budgetCapRaw: scope.budgetCapRaw, maxSteps: scope.maxSteps, deadline: scope.deadline, allowSell: scope.allowSell, hardConditions: scope.hardConditions.length, ...(mandate ? { mandateId: mandate.id, spent: mandate.spent, stepsDone: mandate.stepsDone } : {}) } });

    // ---- 1. facts：事实分拣（用本次核验的全部证据 id 核对 platform_fact）----
    const evidenceIds = new Set<string>([...base.records.map((r) => r.evidenceId), ...quoteEvidence.map((r) => r.evidenceId)]);
    const triage = triageClaims(b.decision, scope.trustTier, evidenceIds);
    const inadmissible = triage.filter((t) => !t.admissible);
    checks.unshift({ id: "facts", ok: inadmissible.length === 0, reasons: inadmissible.length ? [{ code: "DECISION_BASIS_NOT_ADMISSIBLE", severity: "block", evidenceIds: [], detail: { trustTier: scope.trustTier, claims: inadmissible.map((t) => `${t.index}:${t.kind}`).join(",") } }] : [], detail: { trustTier: scope.trustTier, counts: { platform_verified: triage.filter((t) => t.label === "platform_verified").length, platform_unknown_evidence: triage.filter((t) => t.label === "platform_unknown_evidence").length, agent_provided_unverified: triage.filter((t) => t.label === "agent_provided_unverified").length, not_admissible: inadmissible.length }, note: "The decision record is recorded and labelled; it never relaxes a check." } });

    checks.push({ id: "execution", ok: execOk, reasons: execReasons.filter((r) => r.code !== "HARD_CONSTRAINT_BLOCK" && !hardReasons.includes(r)), detail: scopePreOk && factsOk ? execDetail : { skipped: `${!factsOk ? "facts" : "scope"} check failed; no quote was fetched` } });

    // ---- 4. binding ----
    if (live) {
      const bound = !!step && !!mandate && mandate.conditionsHash === bindingHashOf(row) && String((ready?.["certificate"] as { effectivePolicyHash?: string } | undefined)?.effectivePolicyHash ?? "").toLowerCase() === mandate.effectivePolicyHash.toLowerCase();
      checks.push({ id: "binding", ok: bound, reasons: [], detail: step ? { mandateId: mandate!.id, bindingHash: bindingHashOf(row), effectivePolicyHash: mandate!.effectivePolicyHash, stepIndex: step.stepIndex } : { skipped: "no certificate issued" } });
    } else checks.push({ id: "binding", ok: true, reasons: [], detail: { simulation: true, note: "no certificate is signed in SIMULATION" } });

    // facts 不过 → 已签的证书作废（不交出）：决策记录不能是通行证，反过来它也不能带着不可采信的依据拿到证书
    const allOk = checks.every((c) => c.ok);
    if (!allOk && step && mandate) {
      await this.d.db.update(verifyMandateSteps).set({ state: "EXPIRED", validUntil: nowDate, updatedAt: nowDate }).where(and(eq(verifyMandateSteps.mandateId, mandate.id), eq(verifyMandateSteps.stepIndex, step.stepIndex), eq(verifyMandateSteps.state, "PREPARED")));
      step = null;
      ready = null;
    }
    const status: IntentStatus = allOk ? (live ? "certified" : "simulated") : "rejected";
    const [inserted] = await this.d.db.insert(verifyTaskIntents).values({ id: newId("int"), taskId, callerId, ownerAddress: row.ownerAddress, clientRequestId: b.clientRequestId, kind: b.kind, outputAssetKey: b.outputAssetKey, amountInRaw: b.amountInRaw, decisionJson: b.decision, triageJson: triage, checksJson: checks, planDeviationsJson: planDeviations, status, stepJson: step, evidenceIdsJson: [...evidenceIds], createdAt: nowDate, updatedAt: nowDate }).onConflictDoNothing().returning();
    if (!inserted) throw new HttpError(409, "idempotency_conflict");

    // 任务侧：时间线 + 状态 + 通知 + 在途占用
    const failed = checks.filter((c) => !c.ok).map((c) => c.id);
    const note = status === "rejected" ? `intent ${inserted.id} rejected: ${failed.join(", ")} (${[...new Set(checks.flatMap((c) => c.reasons.map((r) => r.code)))].join(", ")})` : `intent ${inserted.id} ${status}: ${b.kind} ${outEntry?.displaySymbol ?? b.outputAssetKey} ${b.amountInRaw}${step ? ` → step ${step.stepIndex}` : ""}`;
    const timeline: TimelineEntry[] = [...(row.timelineJson as TimelineEntry[]), { at: nowIso, type: status === "rejected" ? "intent_rejected" : status === "simulated" ? "intent_simulated" : "intent_certified", ref: inserted.id, note }].slice(-200);
    const lastEval = row.lastEvaluationJson as LastEvaluation | null;
    const extra = { timelineJson: timeline, ...(step && mandate && lastEval ? { lastEvaluationJson: { ...lastEval, mandate: { mandateId: mandate.id, status: "READY", reasons: [], preparedStepIndex: step.stepIndex } } } : {}) };
    let updated: TaskRow;
    if (step && row.status !== "STEP_PREPARED") updated = await this.tasks.setStatus(row, "STEP_PREPARED", `certificate issued on agent intent ${inserted.id}`, extra);
    else updated = (await this.tasks.patch(row.id, { ...extra, updatedAt: nowDate })) ?? row;
    await this.tasks.markTurnIntent(updated, inserted.id, nowIso);
    // 通知 version 必须是 int4：用时间线长度（同一任务内单调递增），不能用 id 的十六进制
    await this.d.notifier.emit(notificationPayload(status === "rejected" ? "task.intent_rejected" : "task.intent_certified", taskId, timeline.length, note.slice(0, 500), `/agent/tasks/${taskId}`, nowIso), row.ownerAddress);
    if (step && mandate && ready) await this.d.budget.markPending(mandate.id, step.stepIndex, b.amountInRaw).catch((err) => log.warn("markPending 失败", { error: err instanceof Error ? err.message : String(err) }));
    log.info("交易意图已处理", { taskId, intentId: inserted.id, status, failed });
    return { httpStatus: status === "rejected" ? 422 : 201, body: await this.responseFor(updated, inserted, ready) };
  }

  private async responseFor(row: TaskRow, intent: IntentRow, ready: Record<string, unknown> | null): Promise<Record<string, unknown>> {
    const v = this.view(intent);
    return { intent: v, taskId: row.id, taskStatus: row.status, ...(ready ?? {}), ...(v.status === "certified" && !ready ? { note: "certificate already handed out on first submission; fetch it via POST /v1/tasks/:id/prepare-step is not applicable — the step is tracked under the mandate" } : {}), scopeBoundary: SCOPE_BOUNDARY_NOTE, stopSemantics: STOP_SEMANTICS_NOTE };
  }

  private simulationJob(row: TaskRow, outputAssetKey: string, amountInRaw: string): { job: NormalizedJob; policy: ReturnType<typeof policyWithConditions> } {
    const goal = row.goalJson as PlanGoal;
    const pdef = findPolicy(goal.policyId, goal.policyVersion)!;
    const resolved = resolveParams(pdef, { maxSlippageBps: goal.maxSlippageBps, maxPriceImpactBps: goal.maxPriceImpactBps, maxReferenceDeviationBps: goal.policyId === "QUOTE_ONLY" ? null : (goal.maxReferenceDeviationBps ?? null) });
    if (!resolved.ok) throw new HttpError(400, "policy_param_out_of_range");
    const policy = policyWithConditions(pdef, resolved.params, bindingHashOf(row));
    const job: NormalizedJob = { clientRequestId: `${row.id}:intent-sim:${Date.now()}`, ownerAddress: goal.ownerAddress, recipientAddress: goal.recipientAddress, executionChainId: goal.executionChainId, inputAssetKey: goal.budget.inputAssetKeys[0]!, outputAssetKey, amountInRaw, mode: "exactIn", policyId: goal.policyId, policyVersion: goal.policyVersion, params: policy.params };
    return { job, policy };
  }

  /* ---------------- 撤回 ---------------- */

  /** agent 撤回自己的意图：certified 且步骤尚未提交 → 步骤作废（已取走的证书在过期前仍可能被执行，D-088） */
  async withdraw(callerId: string, taskId: string, intentId: string): Promise<Record<string, unknown>> {
    const row = await this.tasks.requireTask(callerId, taskId);
    const intent = await this.byId(intentId);
    if (!intent || intent.taskId !== taskId) throw new HttpError(404, "intent_not_found");
    if (intent.status !== "certified" && intent.status !== "simulated") throw new HttpError(409, "intent_not_withdrawable", `意图状态 ${intent.status}`);
    const nowDate = this.now();
    let stepVoided = false;
    const step = intent.stepJson as AgentTradeIntent["step"];
    if (step) {
      const rows = await this.d.db.update(verifyMandateSteps).set({ state: "EXPIRED", validUntil: nowDate, updatedAt: nowDate }).where(and(eq(verifyMandateSteps.mandateId, step.mandateId), eq(verifyMandateSteps.stepIndex, step.stepIndex), eq(verifyMandateSteps.state, "PREPARED"))).returning({ id: verifyMandateSteps.id });
      stepVoided = rows.length > 0;
    }
    const [updated] = await this.d.db.update(verifyTaskIntents).set({ status: "withdrawn", updatedAt: nowDate }).where(eq(verifyTaskIntents.id, intentId)).returning();
    const timeline: TimelineEntry[] = [...(row.timelineJson as TimelineEntry[]), { at: nowDate.toISOString(), type: "intent_withdrawn", ref: intentId, note: stepVoided ? "step certificate voided server-side (a pulled certificate may still execute until it expires)" : "no pending certificate" }].slice(-200);
    const task = (await this.tasks.patch(row.id, { timelineJson: timeline, updatedAt: nowDate })) ?? row;
    const moved = task.status === "STEP_PREPARED" && stepVoided ? await this.tasks.evaluateTask(task, { issue: false }) : task;
    return { intent: this.view(updated!), taskId: row.id, taskStatus: moved.status, stepVoided, stopSemantics: STOP_SEMANTICS_NOTE };
  }
}
