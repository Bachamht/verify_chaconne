/**
 * agent 交易意图（CV-D16 批次 2）：POST /v1/tasks/:id/intents
 *   意图（买什么 / 多少）+ 决策记录（为什么、依据）→ 四道核验（facts 事实分拣 / scope 授权 / execution 执行核验 / binding 绑定）
 *   → LIVE 全过才签步骤证书并交出 guardCall；SIMULATION 只核验不签；任一道不过 → 422 rejected（决策记录照样保存）。
 * 决策记录不是通行证：它只被分类、标注、存档；硬约束与执行核验永远由平台做。计划条件对意图**不阻塞**，偏离只记为 planDeviations。
 * 签证书 ≠ 发交易：执行仍由 agent 调 execute_next_step / 浏览器钱包完成。
 */
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
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
import { MandatesService, policyWithConditions, type EvaluateGateInput, type MandateRow } from "../mandates/service";
import type { IntentBody } from "@chaconne/core/verify";
import { notificationPayload } from "./notify";
import { taskEvidenceIndex } from "../agent/evidence";
import { bindingHashOf, scopeOf, SCOPE_BOUNDARY_NOTE, type LastEvaluation, type TaskRow, type TasksDeps, type TasksService } from "./service";
import { actorOf, appendTimeline } from "../records/timeline";

export type IntentRow = typeof verifyTaskIntents.$inferSelect;

export class IntentsService {
  constructor(private readonly tasks: TasksService, private readonly d: TasksDeps, private readonly now: () => Date) {}

  /* ---------------- 读取 ---------------- */

  async byId(id: string): Promise<IntentRow | null> {
    return (await this.d.db.select().from(verifyTaskIntents).where(eq(verifyTaskIntents.id, id)).limit(1))[0] ?? null;
  }
  async list(callerId: string, taskId: string): Promise<AgentTradeIntent[]> {
    await this.tasks.requireTask(callerId, taskId, "read");
    const rows = await this.d.db.select().from(verifyTaskIntents).where(eq(verifyTaskIntents.taskId, taskId)).orderBy(desc(verifyTaskIntents.createdAt)).limit(100);
    return rows.map((r) => this.view(r));
  }
  /** withStep：certified 且步骤仍 PREPARED 未过期 → 附上 READY 体（guardCall 等），供 agent-wallet 执行器再取 */
  async get(callerId: string, taskId: string, intentId: string, withStep = false): Promise<AgentTradeIntent & { ready?: Record<string, unknown> | null }> {
    await this.tasks.requireTask(callerId, taskId, "read");
    const row = await this.byId(intentId);
    if (!row || row.taskId !== taskId) throw new HttpError(404, "intent_not_found");
    const v = this.view(row);
    if (!withStep) return v;
    // v7：作业制任务不交出 READY 体（执行身份按作业领取并原子取走步骤）
    const task = await this.tasks.byId(taskId);
    if (task?.executorMode === "hosted" && this.d.cfg.v7.hostedExecutor) throw new HttpError(409, "platform_executes", "该任务由平台执行身份执行：READY 体不交出");
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
      ...(r.assetKey ? { assetKey: r.assetKey } : {}),
      ...(r.jobId ? { jobId: r.jobId } : {}),
      ...(r.attempts > 1 ? { attempts: r.attempts } : {}),
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  }

  /* ---------------- 提交 ---------------- */

  async submit(callerId: string, taskId: string, raw: unknown): Promise<{ httpStatus: 200 | 201 | 422; body: Record<string, unknown> }> {
    const row = await this.tasks.requireTask(callerId, taskId, "agent_write");
    const parsed = resolveIntentBody(raw);
    if (!parsed.ok) throw new HttpError(400, "invalid_request", "交易意图校验失败", parsed.errors);
    const b = parsed.body;
    const scope = scopeOf(row);
    if (!scope) throw new HttpError(409, "scope_required", "该任务没有授权范围（建于 CV-D16 之前）：请建新任务再提交意图");
    // v7 卖出体：outputAssetKey 缺省 = 资金币种（给了必须相等——范围检查里报 INTENT_OUT_OF_SCOPE）
    if (b.kind === "sell" && !b.outputAssetKey) b.outputAssetKey = scope.inputAssetKey;
    // 幂等
    const existing = (await this.d.db.select().from(verifyTaskIntents).where(and(eq(verifyTaskIntents.taskId, taskId), eq(verifyTaskIntents.clientRequestId, b.clientRequestId))).limit(1))[0];
    if (existing) {
      if (existing.kind !== b.kind || (existing.assetKey ?? existing.outputAssetKey) !== b.assetKey || existing.amountInRaw !== b.amountInRaw) throw new HttpError(409, "idempotency_conflict", "同一 clientRequestId 已绑定不同意图");
      return { httpStatus: 200, body: await this.responseFor(row, existing, null) };
    }
    // v7（CV-D25，Lane A）：轮次绑定——托管 Agent 每轮一个终结动作、被拒可改一次；turnVersion / nextCheckAt 校验
    const turnGate = await this.tasks.beginAgentAction(callerId, row, raw, "intent");
    return this.run(callerId, row, b, null, turnGate);
  }

  /**
   * v7 自动重签（只对时效类失败，§2.5）：同一意图新报价重新过四道核验；attempts += 1，时间线写 recertified。
   * 调用方（execution/recertify.ts）负责次数与时间窗（AUTO_RECERTIFY_MAX / AUTO_RECERTIFY_WINDOW_S）。
   */
  async recertify(intentId: string): Promise<{ httpStatus: 200 | 201 | 422; body: Record<string, unknown> }> {
    const intent = await this.byId(intentId);
    if (!intent) throw new HttpError(404, "intent_not_found");
    const row = await this.tasks.byId(intent.taskId);
    if (!row) throw new HttpError(404, "task_not_found");
    const b: IntentBody = { clientRequestId: intent.clientRequestId, kind: intent.kind as "buy" | "sell", outputAssetKey: intent.outputAssetKey, assetKey: intent.assetKey ?? intent.outputAssetKey, amountInRaw: intent.amountInRaw, decision: intent.decisionJson as IntentBody["decision"] };
    return this.run(intent.callerId, row, b, intent, null);
  }

  private async run(callerId: string, row: TaskRow, b: IntentBody, prior: IntentRow | null, turnGate: Awaited<ReturnType<TasksService["beginAgentAction"]>> | null): Promise<{ httpStatus: 200 | 201 | 422; body: Record<string, unknown> }> {
    const taskId = row.id;
    const scope = scopeOf(row)!;
    const sell = b.kind === "sell";
    if (row.status === "PAUSED") throw new HttpError(409, "task_paused", "任务已暂停：暂停期间不按意图签发（D-088）");
    if (!TASK_RUNNING_STATUSES.has(row.status as TaskStatus)) throw new HttpError(409, "task_not_active", `任务状态 ${row.status}${row.status === "AWAITING_AUTHORIZATION" ? "：先签授权（POST /v1/tasks/:id/authorize）" : ""}`);
    if (!this.d.cfg.agentC2) throw new HttpError(503, "agent_c2_disabled", "条件层已关闭（AGENT_C2_ENABLED=false）：不签发");

    const nowDate = this.now();
    const nowIso = nowDate.toISOString();
    const live = row.mode === "LIVE";
    const outEntry = findEntry(this.d.registry, sell ? b.assetKey : b.outputAssetKey);
    const v7 = this.tasks.v7Hooks;
    const st = await this.tasks.taskState(row);
    const base = await this.tasks.conditionEvidence(row, st, null);
    const hardSet = makeConditionSet(scope.hardConditions);
    const planSet = row.conditionsJson as ConditionSet;
    const checks: IntentCheck[] = [];
    let planDeviations: Reason[] = [];
    let quoteEvidence: EvidenceRecord[] = [];
    let mandate: MandateRow | null = null;
    let step: { mandateId: string; stepIndex: number; validUntil: string; stepId?: string } | null = null;
    let ready: Record<string, unknown> | null = null;
    let jobId: string | null = null;
    let certEph: string | null = null;
    let v7Detail: Record<string, unknown> = {};

    // ---- 2. scope（不依赖报价的部分）：意图必须在签名范围内 ----
    const scopeReasons: Reason[] = [];
    const oos = (field: string, note: string): Reason => ({ code: "INTENT_OUT_OF_SCOPE", severity: "block", evidenceIds: [], detail: { field, note } });
    if (sell && !(v7 && this.d.cfg.v7.sell)) scopeReasons.push(scope.allowSell ? { code: "SELL_MANDATE_REQUIRED", severity: "block", evidenceIds: [], detail: { note: "sell intents need a per-asset sell authorization (v7 delegation with AGENT_V7_SELL_ENABLED)" } } : oos("kind", "scope.allowSell is false"));
    else if (sell) {
      // v7 卖出：独立范围分支（D-092）。SIMULATION 只查范围（没有持仓与卖出授权）
      if (live) {
        const r = await v7!.intentScope(row, b, null);
        scopeReasons.push(...r.reasons);
        mandate = r.mandate;
        v7Detail = r.detail;
      } else {
        if (!scope.allowSell) scopeReasons.push(oos("kind", "scope.allowSell is false"));
        if (!scope.outputAssetKeys.includes(b.assetKey)) scopeReasons.push(oos("assetKey", `not in scope.outputAssetKeys [${scope.outputAssetKeys.join(", ")}]`));
        if (b.outputAssetKey !== scope.inputAssetKey) scopeReasons.push(oos("outputAssetKey", "a sell converts back to the task's funding asset only"));
      }
    }
    if (!sell && (!outEntry || !scope.outputAssetKeys.includes(b.outputAssetKey))) scopeReasons.push(oos("outputAssetKey", `not in scope.outputAssetKeys [${scope.outputAssetKeys.join(", ")}]`));
    if (!sell && BigInt(b.amountInRaw) > BigInt(scope.perStepCapRaw)) scopeReasons.push(oos("amountInRaw", `exceeds scope.perStepCapRaw ${scope.perStepCapRaw}`));
    if (Date.parse(scope.deadline) <= nowDate.getTime()) scopeReasons.push(oos("deadline", "scope.deadline passed"));
    if (sell) {
      /* 卖出的范围已在上面独立检查 */
    } else if (live) {
      mandate = await this.tasks.currentMandate(row);
      if (!mandate) scopeReasons.push({ code: "AWAITING_USER_SIGNATURE", severity: "block", evidenceIds: [], detail: { note: "no active authorization for the task's current scope" } });
      else {
        if (mandate.state !== "ACTIVE") scopeReasons.push(oos("mandate", `authorization is ${mandate.state}`));
        const remaining = BigInt(mandate.budgetCap) - BigInt(mandate.spent);
        if (BigInt(b.amountInRaw) > remaining) scopeReasons.push(oos("amountInRaw", `exceeds remaining budget ${remaining}`));
        if (mandate.stepsDone >= mandate.maxSteps) scopeReasons.push(oos("maxSteps", `${mandate.stepsDone}/${mandate.maxSteps} steps done`));
        // v7：委托未完成 → DELEGATION_INCOMPLETE；实时额度 / 余额不足 → ALLOWANCE_INSUFFICIENT / BALANCE_INSUFFICIENT
        if (v7 && scopeReasons.length === 0) {
          const r = await v7.intentScope(row, b, mandate);
          scopeReasons.push(...r.reasons);
          v7Detail = r.detail;
        }
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
        const r = await this.d.mandates.issueIntentStep(mandate, { outputAssetKey: sell ? b.assetKey : b.outputAssetKey, amountIn: BigInt(b.amountInRaw), gate, issue: true, side: b.kind });
        // 签发闸门的等待（EXECUTION_IN_FLIGHT / STEP_AWAITING_CONFIRMATION）是信息项，但它就是这次没签的原因——照样列出
        execReasons = r.reasons.filter((x) => x.severity === "block" || x.code === "EXECUTION_IN_FLIGHT" || x.code === "STEP_AWAITING_CONFIRMATION");
        execOk = r.status === "READY" && !!r.step;
        execDetail = { status: r.status, verdict: r.report?.verdict ?? null, marketSession: r.report?.marketSession ?? null, evaluationId: r.evaluation.id, reportHash: r.evaluation.reportHash };
        if (r.step) {
          step = { mandateId: mandate.id, stepIndex: r.step.stepIndex, validUntil: r.step.validUntil.toISOString(), stepId: r.step.id };
          certEph = (r.step.certificateJson as { certificate?: { effectivePolicyHash?: string } }).certificate?.effectivePolicyHash ?? null;
          // v7：作业制任务不调 pullStep、不交出 READY 体——执行身份领取时原子取走
          jobId = v7 ? await v7.enqueueStep(row, mandate, r.step) : null;
          if (!jobId) ready = await this.d.mandates.pullStep(mandate, r.step, r.evaluation);
        }
      } else {
        try {
          const { job, policy } = this.simulationJob(row, sell ? b.assetKey : b.outputAssetKey, b.amountInRaw, b.kind);
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
    checks.push({ id: "scope", ok: scopePreOk && hardBlock.length === 0, reasons: [...scopeReasons, ...hardBlock], detail: { outputAssetKeys: scope.outputAssetKeys, perStepCapRaw: scope.perStepCapRaw, budgetCapRaw: scope.budgetCapRaw, maxSteps: scope.maxSteps, deadline: scope.deadline, allowSell: scope.allowSell, hardConditions: scope.hardConditions.length, ...(mandate ? { mandateId: mandate.id, spent: mandate.spent, stepsDone: mandate.stepsDone } : {}), ...(sell ? { side: "sell", assetKey: b.assetKey } : {}), ...v7Detail } });

    // ---- 1. facts：事实分拣（用本次核验的全部证据 id 核对 platform_fact）----
    const evidenceIds = new Set<string>([...base.records.map((r) => r.evidenceId), ...quoteEvidence.map((r) => r.evidenceId)]);
    const triage = triageClaims(b.decision, scope.trustTier, evidenceIds, await taskEvidenceIndex(this.d.db, taskId, nowDate), nowIso);
    const inadmissible = triage.filter((t) => !t.admissible);
    checks.unshift({ id: "facts", ok: inadmissible.length === 0, reasons: inadmissible.length ? [{ code: "DECISION_BASIS_NOT_ADMISSIBLE", severity: "block", evidenceIds: [], detail: { trustTier: scope.trustTier, claims: inadmissible.map((t) => `${t.index}:${t.kind}`).join(",") } }] : [], detail: { trustTier: scope.trustTier, counts: { platform_verified: triage.filter((t) => t.label === "platform_verified").length, platform_unknown_evidence: triage.filter((t) => t.label === "platform_unknown_evidence").length, agent_provided_unverified: triage.filter((t) => t.label === "agent_provided_unverified").length, not_admissible: inadmissible.length }, note: "The decision record is recorded and labelled; it never relaxes a check." } });

    checks.push({ id: "execution", ok: execOk, reasons: execReasons.filter((r) => r.code !== "HARD_CONSTRAINT_BLOCK" && !hardReasons.includes(r)), detail: scopePreOk && factsOk ? execDetail : { skipped: `${!factsOk ? "facts" : "scope"} check failed; no quote was fetched` } });

    // ---- 4. binding ----
    if (live) {
      const bound = !!step && !!mandate && mandate.conditionsHash === bindingHashOf(row) && String(certEph ?? (ready?.["certificate"] as { effectivePolicyHash?: string } | undefined)?.effectivePolicyHash ?? "").toLowerCase() === mandate.effectivePolicyHash.toLowerCase();
      checks.push({ id: "binding", ok: bound, reasons: [], detail: step ? { mandateId: mandate!.id, bindingHash: bindingHashOf(row), effectivePolicyHash: mandate!.effectivePolicyHash, stepIndex: step.stepIndex } : { skipped: "no certificate issued" } });
    } else checks.push({ id: "binding", ok: true, reasons: [], detail: { simulation: true, note: "no certificate is signed in SIMULATION" } });

    // facts 不过 → 已签的证书作废（不交出）：决策记录不能是通行证，反过来它也不能带着不可采信的依据拿到证书
    const allOk = checks.every((c) => c.ok);
    if (!allOk && step && mandate) {
      // v7：只作废未被取走的行（作业制任务的步骤此刻未被取走；agent-wallet 路径已交出 READY 体 → 保持在途直到签名 validUntil + margin）
      const voided = await this.d.db.update(verifyMandateSteps).set({ state: "EXPIRED", ...(this.d.mandates.v7 ? {} : { validUntil: nowDate }), updatedAt: nowDate }).where(and(eq(verifyMandateSteps.mandateId, mandate.id), eq(verifyMandateSteps.stepIndex, step.stepIndex), eq(verifyMandateSteps.state, "PREPARED"), ...(this.d.mandates.v7 ? [isNull(verifyMandateSteps.pulledAt)] : []))).returning({ id: verifyMandateSteps.id });
      if (v7) await v7.cancelStepJobs(voided.map((x) => x.id), "intent_rejected");
      step = null;
      ready = null;
      jobId = null;
    }
    const status: IntentStatus = allOk ? (live ? "certified" : "simulated") : "rejected";
    let inserted: IntentRow | undefined;
    if (prior) {
      // 自动重签：同一意图，attempts + 1
      [inserted] = await this.d.db.update(verifyTaskIntents).set({ triageJson: triage, checksJson: checks, planDeviationsJson: planDeviations, status, stepJson: step, evidenceIdsJson: [...evidenceIds], attempts: prior.attempts + 1, jobId, updatedAt: nowDate }).where(eq(verifyTaskIntents.id, prior.id)).returning();
    } else {
      [inserted] = await this.d.db.insert(verifyTaskIntents).values({ id: newId("int"), taskId, callerId, ownerAddress: row.ownerAddress, clientRequestId: b.clientRequestId, kind: b.kind, outputAssetKey: b.outputAssetKey, amountInRaw: b.amountInRaw, decisionJson: b.decision, triageJson: triage, checksJson: checks, planDeviationsJson: planDeviations, status, stepJson: step, evidenceIdsJson: [...evidenceIds], createdAt: nowDate, updatedAt: nowDate, assetKey: b.assetKey, turnVersion: turnGate?.binding.turnVersion ?? b.turnVersion ?? null, jobId, nextCheckAt: turnGate?.binding.nextCheckAt ? new Date(turnGate.binding.nextCheckAt) : b.nextCheckAt ? new Date(b.nextCheckAt) : null }).onConflictDoNothing().returning();
    }
    if (!inserted) throw new HttpError(409, "idempotency_conflict");
    // v7：同一授权的新意图签发 → 旧意图的步骤从未被取走则转 superseded，并取消其作业
    if (step && mandate && this.d.mandates.v7) await this.supersedeOlder(row.id, inserted.id, mandate.id);

    // 任务侧：时间线 + 状态 + 通知 + 在途占用
    const failed = checks.filter((c) => !c.ok).map((c) => c.id);
    const note = status === "rejected" ? `intent ${inserted.id} rejected: ${failed.join(", ")} (${[...new Set(checks.flatMap((c) => c.reasons.map((r) => r.code)))].join(", ")})` : `intent ${inserted.id} ${status}: ${b.kind} ${outEntry?.displaySymbol ?? b.outputAssetKey} ${b.amountInRaw}${step ? ` → step ${step.stepIndex}` : ""}`;
    const tl = await appendTimeline(this.d.db, row.id, { at: nowIso, type: prior ? (status === "certified" ? "recertified" : "recertify_failed") : status === "rejected" ? "intent_rejected" : status === "simulated" ? "intent_simulated" : "intent_certified", ref: inserted.id, note: prior ? `auto re-certified (attempt ${inserted.attempts}): ${note}` : note, data: { intentId: inserted.id, status, ...(jobId ? { jobId } : {}), ...(prior ? { attempt: inserted.attempts } : {}) } }, prior ? "system" : actorOf(callerId));
    const lastEval = row.lastEvaluationJson as LastEvaluation | null;
    const extra = { ...(step && mandate && lastEval ? { lastEvaluationJson: { ...lastEval, mandate: { mandateId: mandate.id, status: "READY", reasons: [], preparedStepIndex: step.stepIndex } } } : {}) };
    let updated: TaskRow;
    if (step && row.status !== "STEP_PREPARED") updated = await this.tasks.setStatus(row, "STEP_PREPARED", `certificate issued on agent intent ${inserted.id}`, extra, actorOf(callerId));
    else updated = (await this.tasks.patch(row.id, { ...extra, updatedAt: nowDate })) ?? row;
    // 自动重签（turnGate = null）不关闭轮次：它是平台对同一意图的重试，不是 Agent 的新动作
    if (turnGate) await this.tasks.markTurnIntent(updated, inserted.id, nowIso, { turnVersion: turnGate.binding.turnVersion, status, clientRequestId: b.clientRequestId, nextCheckAt: turnGate.binding.nextCheckAt, hosted: turnGate.hosted });
    // 通知 version 必须是 int4：用时间线行 id（verify_task_timeline 的 bigserial，单调递增），不能用意图 id 的十六进制
    await this.d.notifier.emit(notificationPayload(status === "rejected" ? "task.intent_rejected" : "task.intent_certified", taskId, tl.ids[0] ?? 0, note.slice(0, 500), `/agent/tasks/${taskId}`, nowIso), row.ownerAddress);
    // 卖出授权从不触碰资金组账目（D-092）：不 markPending
    if (step && mandate && (ready || jobId) && !MandatesService.isDelegationSell(mandate)) await this.d.budget.markPending(mandate.id, step.stepIndex, b.amountInRaw).catch((err) => log.warn("markPending 失败", { error: err instanceof Error ? err.message : String(err) }));
    log.info("交易意图已处理", { taskId, intentId: inserted.id, status, failed });
    const resp = await this.responseFor(updated, inserted, ready);
    if (jobId) resp["execution"] = { mode: "hosted", jobId, note: "the platform executor sends this step; no READY body is handed out" };
    return { httpStatus: status === "rejected" ? 422 : 201, body: resp };
  }

  /** 旧意图（同任务同授权、certified、步骤从未被取走）→ superseded，取消其未发送作业 */
  private async supersedeOlder(taskId: string, keepId: string, mandateId: string): Promise<void> {
    const olds = await this.d.db.select().from(verifyTaskIntents).where(and(eq(verifyTaskIntents.taskId, taskId), eq(verifyTaskIntents.status, "certified")));
    const v7 = this.tasks.v7Hooks;
    for (const o of olds) {
      const st = o.stepJson as { mandateId?: string; stepId?: string } | null;
      if (o.id === keepId || !st || st.mandateId !== mandateId) continue;
      const stepRow = st.stepId ? await this.d.mandates.stepById(st.stepId) : null;
      if (stepRow && stepRow.pulledAt) continue;
      await this.d.db.update(verifyTaskIntents).set({ status: "superseded", updatedAt: this.now() }).where(and(eq(verifyTaskIntents.id, o.id), eq(verifyTaskIntents.status, "certified")));
      if (v7 && st.stepId) await v7.cancelStepJobs([st.stepId], "superseded");
    }
  }

  private async responseFor(row: TaskRow, intent: IntentRow, ready: Record<string, unknown> | null): Promise<Record<string, unknown>> {
    const v = this.view(intent);
    return { intent: v, taskId: row.id, taskStatus: row.status, ...(ready ?? {}), ...(v.status === "certified" && !ready ? { note: "certificate already handed out on first submission; fetch it via POST /v1/tasks/:id/prepare-step is not applicable — the step is tracked under the mandate" } : {}), scopeBoundary: SCOPE_BOUNDARY_NOTE, stopSemantics: STOP_SEMANTICS_NOTE };
  }

  private simulationJob(row: TaskRow, assetKey: string, amountInRaw: string, side: "buy" | "sell" = "buy"): { job: NormalizedJob; policy: ReturnType<typeof policyWithConditions> } {
    const goal = row.goalJson as PlanGoal;
    const pdef = findPolicy(goal.policyId, goal.policyVersion)!;
    const resolved = resolveParams(pdef, { maxSlippageBps: goal.maxSlippageBps, maxPriceImpactBps: goal.maxPriceImpactBps, maxReferenceDeviationBps: goal.policyId === "QUOTE_ONLY" ? null : (goal.maxReferenceDeviationBps ?? null) });
    if (!resolved.ok) throw new HttpError(400, "policy_param_out_of_range");
    const policy = policyWithConditions(pdef, resolved.params, bindingHashOf(row));
    // v7：SIMULATION 卖出方向（输入 = 股票，输出 = 资金币种；路由按 amountIn − 容差取，与 LIVE 一致）
    const stable = scopeOf(row)?.inputAssetKey ?? goal.budget.inputAssetKeys[0]!;
    const tol = BigInt(this.d.cfg.SELL_INPUT_TOLERANCE_WEI);
    const routeAmount = side === "sell" && BigInt(amountInRaw) > tol ? (BigInt(amountInRaw) - tol).toString() : amountInRaw;
    const job: NormalizedJob = side === "sell"
      ? { clientRequestId: `${row.id}:intent-sim:${Date.now()}`, ownerAddress: goal.ownerAddress, recipientAddress: goal.recipientAddress, executionChainId: goal.executionChainId, inputAssetKey: assetKey, outputAssetKey: stable, amountInRaw: routeAmount, mode: "exactIn", policyId: goal.policyId, policyVersion: goal.policyVersion, params: policy.params, side: "sell" }
      : { clientRequestId: `${row.id}:intent-sim:${Date.now()}`, ownerAddress: goal.ownerAddress, recipientAddress: goal.recipientAddress, executionChainId: goal.executionChainId, inputAssetKey: goal.budget.inputAssetKeys[0]!, outputAssetKey: assetKey, amountInRaw, mode: "exactIn", policyId: goal.policyId, policyVersion: goal.policyVersion, params: policy.params };
    return { job, policy };
  }

  /* ---------------- 撤回 ---------------- */

  /** agent 撤回自己的意图：certified 且步骤尚未提交 → 步骤作废（已取走的证书在过期前仍可能被执行，D-088） */
  async withdraw(callerId: string, taskId: string, intentId: string): Promise<Record<string, unknown>> {
    const row = await this.tasks.requireTask(callerId, taskId, "agent_write");
    const intent = await this.byId(intentId);
    if (!intent || intent.taskId !== taskId) throw new HttpError(404, "intent_not_found");
    if (intent.status !== "certified" && intent.status !== "simulated") throw new HttpError(409, "intent_not_withdrawable", `意图状态 ${intent.status}`);
    const nowDate = this.now();
    let stepVoided = false;
    const step = intent.stepJson as AgentTradeIntent["step"];
    if (step && this.d.mandates.v7) {
      // v7：只作废未被取走的行；已取走的：取消未进 SENDING 的作业，行保持在途直到签名 validUntil + margin
      const sid = (intent.stepJson as { stepId?: string }).stepId;
      const target = sid ? [sid] : (await this.d.mandates.rowsAt(step.mandateId, step.stepIndex)).filter((r) => r.state === "PREPARED").map((r) => r.id);
      const rows = target.length ? await this.d.db.update(verifyMandateSteps).set({ state: "EXPIRED", updatedAt: nowDate }).where(and(inArray(verifyMandateSteps.id, target), eq(verifyMandateSteps.state, "PREPARED"), isNull(verifyMandateSteps.pulledAt))).returning({ id: verifyMandateSteps.id }) : [];
      stepVoided = rows.length > 0;
      if (this.tasks.v7Hooks) await this.tasks.v7Hooks.cancelStepJobs(target, "intent_withdrawn");
    } else if (step) {
      const rows = await this.d.db.update(verifyMandateSteps).set({ state: "EXPIRED", validUntil: nowDate, updatedAt: nowDate }).where(and(eq(verifyMandateSteps.mandateId, step.mandateId), eq(verifyMandateSteps.stepIndex, step.stepIndex), eq(verifyMandateSteps.state, "PREPARED"))).returning({ id: verifyMandateSteps.id });
      stepVoided = rows.length > 0;
    }
    const [updated] = await this.d.db.update(verifyTaskIntents).set({ status: "withdrawn", updatedAt: nowDate }).where(eq(verifyTaskIntents.id, intentId)).returning();
    const patched = (await this.tasks.patch(row.id, { updatedAt: nowDate })) ?? row;
    const task = (await appendTimeline(this.d.db, row.id, { at: nowDate.toISOString(), type: "intent_withdrawn", ref: intentId, note: stepVoided ? "step certificate voided server-side (a pulled certificate may still execute until it expires)" : "no pending certificate" }, actorOf(callerId))).row ?? patched;
    const moved = task.status === "STEP_PREPARED" && stepVoided ? await this.tasks.evaluateTask(task, { issue: false }) : task;
    return { intent: this.view(updated!), taskId: row.id, taskStatus: moved.status, stepVoided, stopSemantics: STOP_SEMANTICS_NOTE };
  }
}
