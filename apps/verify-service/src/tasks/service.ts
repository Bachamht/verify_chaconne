/**
 * 任务（C3，interfaces §11.5–11.7）：playbook + 参数 → PlanGoal → 规划候选 → 授权草案 → 资金组分配 → 理由卡；
 * 12 态状态机；prepare-step 前置链 = evaluateConditions → 资金组/现金下限 → 理由卡 → 现有 mandates.prepareStep（证据、报价、证书 TTL 规则不变）。
 * conditionsHash 进 effectivePolicyHash 展开参数 → 证书与证据包（K-10）。停止语义 D-088：服务侧只阻止后续签发。
 */
import { and, desc, eq, inArray, lt } from "drizzle-orm";
import type { Db } from "@chaconne/db";
import { verifyTaskBlockers, verifyTasks } from "@chaconne/db";
import {
  blockerFromReason,
  blockerSetKey,
  blockersFromEvaluation,
  buildReport,
  EIP712_TYPES_V2,
  evaluateConditions,
  findEntry,
  findPolicy,
  isEvmAddress,
  isPlaybookId,
  makePlanGuardDomain,
  mergeConditions,
  nextRegularOpenMs,
  normalizeAddress,
  nyDateAt,
  outputSetHash,
  playbookBudget,
  playbookGoal,
  registryHash,
  resolveParams,
  runningStatusAfterEvaluation,
  STOP_SEMANTICS_NOTE,
  TASK_MONITORED_STATUSES,
  TASK_RUNNING_STATUSES,
  TASK_TERMINAL_STATUSES,
  thesisHoldsCondition,
  validatePlaybookParams,
  makeConditionSet,
  canTransition,
  QUOTE_DEPENDENT_CONDITION_TYPES,
  INFO_ONLY_CODES,
  type Blocker,
  type Condition,
  type ConditionEvaluation,
  type ConditionEvaluationRecord,
  type ConditionEvidence,
  type ConditionSet,
  type TaskConditionState,
  type EffectivePolicy,
  type EvidenceRecord,
  type EvmAddress,
  type NormalizedJob,
  type PlanGoal,
  type PlanReport,
  type PlaybookCatalog,
  type PlaybookDefinition,
  type Reason,
  type Task,
  type TaskStatus,
  type ThesisOnInvalidation,
  type TradeMandate,
  type VerifyReport,
  type AssetRegistry,
} from "@chaconne/core/verify";
import type { VerifyConfig } from "../config";
import type { EvidenceProvider } from "../evidence/provider";
import { newId } from "../ids";
import { log } from "../log";
import { HttpError } from "../jobs/service";
import { MandatesService, policyWithConditions, type EvaluateGateInput, type MandateRow } from "../mandates/service";
import type { Orders } from "../payments/orders";
import type { PlanEngine } from "../plans/engine";
import type { ContextService } from "../context/service";
import type { ThesesService, ThesisRow } from "../theses/service";
import type { BudgetCoordinator } from "./budget";
import { notificationPayload, type TaskNotifier } from "./notify";
import { playbookOf } from "./playbooks";
import { postEarningsGate } from "../impacts/postEarningsWait";

export type TaskRow = typeof verifyTasks.$inferSelect;

export interface TasksDeps {
  db: Db;
  cfg: VerifyConfig;
  registry: AssetRegistry;
  evidence: EvidenceProvider;
  engine: PlanEngine;
  mandates: MandatesService;
  theses: ThesesService;
  context: ContextService;
  budget: BudgetCoordinator;
  notifier: TaskNotifier;
  orders: Orders;
  playbooks: PlaybookCatalog;
  /** 执行器在线态（Lane C 心跳）；缺省：有授权 = awaiting_signature（浏览器钱包路径），无 = offline */
  executorPresence?: (row: TaskRow) => Promise<Task["executorPresence"]>;
  now?: () => Date;
}

interface TimelineEntry {
  at: string;
  type: string;
  from?: TaskStatus;
  to?: TaskStatus;
  note?: string;
  ref?: string;
}
interface MandateDraft {
  mandate: TradeMandate;
  domain: ReturnType<typeof makePlanGuardDomain>;
  typedData: { domain: ReturnType<typeof makePlanGuardDomain>; types: typeof EIP712_TYPES_V2; primaryType: "TradeMandate"; message: TradeMandate };
  outputSet: EvmAddress[];
  conditionsHash: string;
  effectivePolicyHash: string;
  policyDefinitionHash: string;
  registerBody: Record<string, unknown>;
  note: string;
}
interface LastEvaluation {
  evaluatedAt: string;
  outcome: ConditionEvaluation["outcome"];
  conditionsHash: string;
  perItem: ConditionEvaluation["perItem"];
  nextCheckAt: string | null;
  mandate: { mandateId: string; status: string; reasons: Reason[]; preparedStepIndex: number | null } | null;
  simulation: { wouldIssue: boolean; reportVerdict: string | null; reasons: Reason[] } | null;
  thesis: { thesisId: string; status: string; action: string | null } | null;
  quoteFetched: boolean;
}

const WAIT_NEXT_REGULAR: ReadonlySet<string> = new Set(["MARKET_OUTSIDE_REGULAR", "REFERENCE_STALE", "CLOSE_SESSION_MISMATCH", "REFERENCE_MISSING"]);

export class TasksService {
  private readonly now: () => Date;
  constructor(private readonly d: TasksDeps) {
    this.now = d.now ?? (() => new Date());
    d.mandates.setStepConfirmedListener((a) => this.onStepConfirmed(a));
  }

  /* ---------------- 鉴权 / 读取 ---------------- */

  ownerOf(callerId: string, bodyOwner?: unknown): EvmAddress {
    const m = callerId.match(/(0x[0-9a-f]{40})$/);
    if (m) return m[1] as EvmAddress;
    if (typeof bodyOwner === "string" && isEvmAddress(bodyOwner)) return normalizeAddress(bodyOwner);
    throw new HttpError(400, "owner_required", "该调用方需要在请求体给出 ownerAddress");
  }
  async byId(id: string): Promise<TaskRow | null> {
    return (await this.d.db.select().from(verifyTasks).where(eq(verifyTasks.id, id)).limit(1))[0] ?? null;
  }
  async requireTask(callerId: string, id: string): Promise<TaskRow> {
    const row = await this.byId(id);
    if (!row || row.callerId !== callerId) throw new HttpError(403, "task_forbidden", "任务不存在或不属于该调用方");
    return row;
  }
  async list(callerId: string, owner?: string): Promise<TaskRow[]> {
    const rows = await this.d.db.select().from(verifyTasks).where(eq(verifyTasks.callerId, callerId)).orderBy(desc(verifyTasks.createdAt)).limit(200);
    return owner ? rows.filter((r) => r.ownerAddress === owner.toLowerCase()) : rows;
  }
  /** 跨调用方按 owner 读（Lane D 影响清单 / 修订传播：只读，不含私密字段） */
  async listByOwner(owner: string): Promise<TaskRow[]> {
    return this.d.db.select().from(verifyTasks).where(eq(verifyTasks.ownerAddress, owner.toLowerCase())).orderBy(desc(verifyTasks.createdAt)).limit(200);
  }

  /* ---------------- 创建 ---------------- */

  async create(callerId: string, raw: unknown): Promise<{ status: 200 | 201; body: Record<string, unknown> }> {
    const b = (raw ?? {}) as Record<string, unknown>;
    const errors: Array<{ field: string; code: string }> = [];
    const clientRequestId = typeof b["clientRequestId"] === "string" && /^[A-Za-z0-9_\-:.]{1,128}$/.test(b["clientRequestId"]) ? b["clientRequestId"] : null;
    if (!clientRequestId) errors.push({ field: "clientRequestId", code: "required" });
    if (!isPlaybookId(b["playbookId"])) errors.push({ field: "playbookId", code: "unknown_playbook" });
    const mode = b["mode"] === "LIVE" ? "LIVE" : b["mode"] === undefined || b["mode"] === "SIMULATION" ? "SIMULATION" : null;
    if (!mode) errors.push({ field: "mode", code: "expected_LIVE|SIMULATION" });
    if (errors.length) throw new HttpError(400, "invalid_request", "任务请求校验失败", errors);
    const owner = this.ownerOf(callerId, b["ownerAddress"]);
    const recipient = typeof b["recipientAddress"] === "string" && isEvmAddress(b["recipientAddress"]) ? normalizeAddress(b["recipientAddress"]) : owner;
    const def = playbookOf(this.d.playbooks, b["playbookId"] as PlaybookDefinition["id"]);
    if (def.implementedBy !== "lane_b") throw new HttpError(501, "playbook_not_implemented", `${def.id} 由 Lane C 编排（/v1/rebalance/*）`);
    if (mode === "SIMULATION" && !def.simulationAllowed) throw new HttpError(400, "simulation_not_allowed");

    // 幂等
    const existing = (await this.d.db.select().from(verifyTasks).where(and(eq(verifyTasks.callerId, callerId), eq(verifyTasks.clientRequestId, clientRequestId!))).limit(1))[0];
    if (existing) {
      if (existing.playbookId !== def.id || existing.ownerAddress !== owner) throw new HttpError(409, "idempotency_conflict", "同一 clientRequestId 已绑定不同任务");
      return { status: 200, body: await this.view(existing) };
    }

    // Y-01 参数校验
    const pv = validatePlaybookParams(def, b["params"]);
    if (!pv.ok) throw new HttpError(400, "invalid_playbook_params", "模板参数校验失败", pv.errors);
    const params = pv.params;
    const inEntry = findEntry(this.d.registry, String(params["inputAssetKey"]));
    const outEntry = findEntry(this.d.registry, String(params["outputAssetKey"]));
    if (!inEntry || inEntry.role !== "stable_input") throw new HttpError(400, "asset_unsupported", "inputAssetKey 必须是登记表内的资金币种", [{ field: "params.inputAssetKey", code: "not_stable_input" }]);
    if (!outEntry || outEntry.role !== "stock_output") throw new HttpError(400, "asset_unsupported", "outputAssetKey 必须是登记表内的股票代币", [{ field: "params.outputAssetKey", code: "not_stock_output" }]);
    if (mode === "LIVE" && !outEntry.executionAllowed) throw new HttpError(400, "asset_unsupported", "该股票代币未放行执行", [{ field: "params.outputAssetKey", code: "execution_not_allowed" }]);

    const nowDate = this.now();
    const nowIso = nowDate.toISOString();
    const taskId = newId("tsk");
    const thesisId = newId("ths");
    // 条件：模板默认 + 用户覆盖（Y-05 / K-08 在 DSL 校验里）+ 理由卡联动（T-06）
    const userItems = b["conditions"] && typeof b["conditions"] === "object" && Array.isArray((b["conditions"] as { items?: unknown }).items) ? ((b["conditions"] as { items: unknown[] }).items) : null;
    const mc = mergeConditions(def, params, userItems, mode!);
    if (!mc.ok) throw new HttpError(400, "invalid_conditions", "条件校验失败", mc.errors);
    const conditions: ConditionSet = makeConditionSet([...mc.set.items.filter((i) => i.type !== "thesis_holds"), thesisHoldsCondition(thesisId)]);
    const goal = playbookGoal({ ownerAddress: owner, recipientAddress: recipient, executionChainId: this.d.cfg.EXECUTION_CHAIN_ID, params, def, nowIso });
    if (Date.parse(goal.deadline) <= nowDate.getTime()) throw new HttpError(400, "invalid_playbook_params", "deadline 必须在未来", [{ field: "params.deadline", code: "must_be_future" }]);
    const { steps, perStepAmountRaw } = playbookBudget(def, params);

    // 规划候选（SIMULATION / LIVE 都跑；上游不可达时不阻塞建任务，记 null）
    let plan: PlanReport | null = null;
    let planId: string | null = null;
    try {
      planId = newId("pln");
      const r = await this.d.engine.plan(goal, { registry: this.d.registry, evidence: this.d.evidence, nowIso, planId });
      plan = r.report;
    } catch (err) {
      log.warn("建任务时规划失败（不阻塞建任务）", { taskId, error: err instanceof Error ? err.message : String(err) });
      plan = null;
      planId = null;
    }

    // 授权草案（LIVE；SIMULATION 不需要）
    const mandateDraft = mode === "LIVE" ? this.buildMandateDraft({ taskId, goal, conditions, steps, perStepAmountRaw, nowSec: Math.floor(nowDate.getTime() / 1000), nonce: typeof b["mandateNonce"] === "string" && /^\d+$/.test(b["mandateNonce"]) ? b["mandateNonce"] : String(Math.floor(nowDate.getTime() / 1000)) }) : null;

    // 资金组分配（Lane C 未就绪 → stub 全额预留）
    const priority = Number.isInteger(b["priority"]) ? (b["priority"] as number) : 0;
    const budgetGroupId = typeof b["budgetGroupId"] === "string" ? b["budgetGroupId"] : null;
    const allocation = { ...(await this.d.budget.reserve({ owner, taskId, mandateId: null, budgetGroupId, inputAssetKey: inEntry.assetKey, amountRaw: goal.budget.amountInRaw, priority, createdAt: nowIso, mandateDeadline: goal.deadline })), priority };

    const timeline: TimelineEntry[] = [{ at: nowIso, type: "created", to: "DRAFT", note: `${def.id} ${mode}` }];
    const initial: TaskStatus = mode === "LIVE" ? "AWAITING_AUTHORIZATION" : "ACTIVE";
    timeline.push({ at: nowIso, type: "status", from: "DRAFT", to: initial });
    const [row] = await this.d.db
      .insert(verifyTasks)
      .values({
        id: taskId,
        callerId,
        clientRequestId: clientRequestId!,
        ownerAddress: owner,
        playbookId: def.id,
        playbookVersion: this.d.playbooks.version,
        paramsJson: params,
        goalJson: goal,
        conditionsJson: conditions,
        conditionsHash: conditions.hash,
        mode: mode!,
        status: initial,
        mandateIds: [],
        thesisId,
        budgetGroupId,
        blockersJson: [],
        nextCheckAt: null,
        lastEvaluationJson: null,
        planId,
        planJson: plan,
        mandateDraftJson: mandateDraft,
        budgetAllocationJson: allocation,
        timelineJson: timeline,
        exitDraftJson: null,
        stepsConfirmed: 0,
        stepsPlanned: steps,
        lastConfirmedStepAt: null,
        deadline: new Date(goal.deadline),
        createdAt: nowDate,
        updatedAt: nowDate,
      })
      .onConflictDoNothing()
      .returning();
    if (!row) throw new HttpError(409, "idempotency_conflict");

    // 理由卡（每个任务一张；机器前提 = 条件三态；research 前提来自 body.thesis）
    await this.d.theses.create({ id: thesisId, callerId, owner, taskId, mode: mode!, raw: b["thesis"], conditionsForMachinePremises: conditions.items.filter((i) => i.type !== "thesis_holds"), defaultGoal: `${def.name.en}: ${def.side} ${outEntry.displaySymbol} in ${steps} step(s)`, defaultValidUntil: goal.deadline });

    // 首次评估（SIMULATION 立即可用；LIVE 也先给出阻塞项全量，K-02）
    const evaluated = await this.evaluateTask(row, { issue: false });
    log.info("任务已创建", { taskId, playbook: def.id, mode, status: evaluated.status, blockers: (evaluated.blockersJson as Blocker[]).map((x) => x.code) });
    return { status: 201, body: await this.view(evaluated) };
  }

  private buildMandateDraft(a: { taskId: string; goal: PlanGoal; conditions: ConditionSet; steps: number; perStepAmountRaw: string; nowSec: number; nonce: string }): MandateDraft {
    const planGuard = this.d.cfg.PLANGUARD_ADDRESS;
    if (!planGuard) throw new HttpError(503, "planguard_not_configured", "LIVE 任务需要 PLANGUARD_ADDRESS；可先用 mode=SIMULATION");
    const def = findPolicy(a.goal.policyId, a.goal.policyVersion);
    if (!def) throw new HttpError(400, "unknown_policy");
    const resolved = resolveParams(def, { maxSlippageBps: a.goal.maxSlippageBps, maxPriceImpactBps: a.goal.maxPriceImpactBps, maxReferenceDeviationBps: a.goal.policyId === "QUOTE_ONLY" ? null : (a.goal.maxReferenceDeviationBps ?? null) });
    if (!resolved.ok) throw new HttpError(400, "policy_param_out_of_range", "策略参数越界", resolved.errors);
    const policy = policyWithConditions(def, resolved.params, a.conditions.hash);
    const sell = a.goal.side === "sell";
    const stableKey = sell ? a.goal.legs[0]!.outputAssetKey : a.goal.budget.inputAssetKeys[0]!;
    const stockKey = sell ? a.goal.budget.inputAssetKeys[0]! : a.goal.legs[0]!.outputAssetKey;
    const stable = findEntry(this.d.registry, stableKey)!;
    const stock = findEntry(this.d.registry, stockKey)!;
    const mandate: TradeMandate = {
      owner: a.goal.ownerAddress,
      recipient: a.goal.recipientAddress,
      inputToken: sell ? stock.tokenAddress : stable.tokenAddress,
      outputSetHash: outputSetHash(sell ? [stable.tokenAddress] : [stock.tokenAddress]),
      budgetCap: a.goal.budget.amountInRaw,
      perStepCap: a.perStepAmountRaw,
      maxSteps: String(a.steps),
      policyDefinitionHash: policy.policyDefinitionHash,
      effectivePolicyHash: policy.effectivePolicyHash,
      registryHash: registryHash(this.d.registry),
      validFrom: String(a.nowSec - 60),
      deadline: String(Math.floor(Date.parse(a.goal.deadline) / 1000)),
      nonce: a.nonce,
    };
    const domain = makePlanGuardDomain(this.d.cfg.EXECUTION_CHAIN_ID, planGuard as EvmAddress);
    const registerBody = { clientRequestId: `${a.taskId}:auth`, inputAssetKey: stable.assetKey, legs: [{ outputAssetKey: stock.assetKey, weightBps: 10_000 }], side: a.goal.side, policyId: a.goal.policyId, policyVersion: a.goal.policyVersion, maxSlippageBps: resolved.params.maxSlippageBps, maxPriceImpactBps: resolved.params.maxPriceImpactBps, maxReferenceDeviationBps: resolved.params.maxReferenceDeviationBps, conditionsHash: a.conditions.hash, sku: "task_bundle" };
    const outputSet: EvmAddress[] = sell ? [stable.tokenAddress] : [stock.tokenAddress];
    return { mandate, domain, typedData: { domain, types: EIP712_TYPES_V2, primaryType: "TradeMandate", message: mandate }, outputSet, conditionsHash: a.conditions.hash, effectivePolicyHash: policy.effectivePolicyHash, policyDefinitionHash: policy.policyDefinitionHash, registerBody, note: "Sign typedData with the owner wallet and POST it to /v1/tasks/:id/authorize as { signature }. effectivePolicyHash expands conditionsHash: changing conditions requires a new authorization (K-09)." };
  }

  /* ---------------- 视图 ---------------- */

  taskOf(row: TaskRow, presence: Task["executorPresence"]): Task {
    return {
      id: row.id,
      owner: row.ownerAddress as EvmAddress,
      playbookId: row.playbookId as Task["playbookId"],
      goal: row.goalJson as PlanGoal,
      conditions: row.conditionsJson as ConditionSet,
      mandateIds: row.mandateIds,
      ...(row.thesisId ? { thesisId: row.thesisId } : {}),
      ...(row.budgetGroupId ? { budgetGroupId: row.budgetGroupId } : {}),
      status: row.status as TaskStatus,
      blockers: row.blockersJson as Blocker[],
      nextCheckAt: row.nextCheckAt?.toISOString() ?? null,
      executorPresence: presence,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async presenceOf(row: TaskRow): Promise<Task["executorPresence"]> {
    if (this.d.executorPresence) return this.d.executorPresence(row);
    return row.mandateIds.length > 0 ? "awaiting_signature" : "offline";
  }

  async view(row: TaskRow): Promise<Record<string, unknown>> {
    const presence = await this.presenceOf(row);
    const task = this.taskOf(row, presence);
    const mandates = [];
    for (const id of row.mandateIds) {
      const m = await this.d.mandates.byId(id);
      if (!m) continue;
      const steps = await this.d.mandates.steps(id);
      mandates.push({
        mandateId: m.id,
        state: m.state,
        conditionsHash: m.conditionsHash,
        current: m.conditionsHash === row.conditionsHash,
        spent: m.spent,
        stepsDone: m.stepsDone,
        maxSteps: m.maxSteps,
        deadline: m.deadline.toISOString(),
        /** 已取走且未过期的证书：服务侧停止后仍可能可执行（D-088） */
        pulledUnexpiredSteps: steps.filter((s) => s.pulledAt && !s.txHash && s.validUntil.getTime() > this.now().getTime()).map((s) => s.stepIndex),
        /** 链上撤销确认：由回执核实（Lane C）写回；REVOKE_PENDING 期间为 pending */
        revokeStatus: row.status === "REVOKED" ? "confirmed" : row.status === "REVOKE_PENDING" ? "pending" : "none",
      });
    }
    const thesisRow = row.thesisId ? await this.d.theses.byId(row.thesisId) : null;
    const plan = row.planJson as PlanReport | null;
    return {
      task,
      mode: row.mode,
      playbookVersion: row.playbookVersion,
      params: row.paramsJson,
      steps: { planned: row.stepsPlanned, confirmed: row.stepsConfirmed, lastConfirmedAt: row.lastConfirmedStepAt?.toISOString() ?? null },
      plan: plan ? { planId: plan.planId, planHash: plan.planHash, evaluatedAt: plan.evaluatedAt, recommended: plan.recommended, candidates: plan.candidates.map((c) => ({ candidateId: c.candidateId, amountInRaw: c.amountInRaw, expectedOutRaw: c.expectedOutRaw, adverseImpactBps: c.adverseImpactBps, verdict: c.chosenPolicyVerdict, nextStep: c.nextStep })) } : null,
      mandateDraft: row.status === "AWAITING_AUTHORIZATION" ? row.mandateDraftJson : null,
      mandates,
      thesis: thesisRow ? this.d.theses.card(thesisRow) : null,
      /** F 页面用名：与 thesis 同一张卡 */
      thesisDraft: thesisRow ? this.d.theses.card(thesisRow) : null,
      budgetAllocation: row.budgetAllocationJson,
      lastEvaluation: row.lastEvaluationJson,
      exitDraft: row.exitDraftJson,
      timeline: row.timelineJson,
      stopSemantics: STOP_SEMANTICS_NOTE,
      evidenceMode: row.mode === "SIMULATION" ? "SIMULATION" : this.d.evidence.mode,
    };
  }

  /* ---------------- 状态转移 ---------------- */

  private async setStatus(row: TaskRow, to: TaskStatus, note: string, extra: Partial<typeof verifyTasks.$inferInsert> = {}): Promise<TaskRow> {
    const from = row.status as TaskStatus;
    if (from !== to && !canTransition(from, to)) throw new HttpError(409, "invalid_transition", `${from} → ${to} 不允许`);
    const now = this.now();
    const timeline = [...(row.timelineJson as TimelineEntry[]), ...(from !== to ? [{ at: now.toISOString(), type: "status", from, to, note }] : [])].slice(-200);
    const [updated] = await this.d.db.update(verifyTasks).set({ status: to, timelineJson: timeline, updatedAt: now, ...extra }).where(and(eq(verifyTasks.id, row.id), eq(verifyTasks.status, from))).returning();
    if (!updated) throw new HttpError(409, "concurrent_update");
    if (from !== to) await this.d.notifier.emit(notificationPayload("task.status_changed", row.id, timeline.length, `${from} → ${to}: ${note}`, `/agent/tasks/${row.id}`, now.toISOString()), row.ownerAddress);
    return updated;
  }

  async transition(callerId: string, id: string, action: "pause" | "resume" | "cancel"): Promise<{ row: TaskRow; note: string }> {
    const row = await this.requireTask(callerId, id);
    const from = row.status as TaskStatus;
    if (action === "pause") {
      if (!TASK_RUNNING_STATUSES.has(from)) throw new HttpError(409, "invalid_transition", `${from} 不能暂停`);
      for (const mid of row.mandateIds) {
        const m = await this.d.mandates.byId(mid);
        if (m?.state === "ACTIVE") await this.d.mandates.transition(callerId, mid, "PAUSED");
      }
      return { row: await this.setStatus(row, "PAUSED", "paused by owner (service-side: stops issuance only)"), note: STOP_SEMANTICS_NOTE };
    }
    if (action === "resume") {
      if (from !== "PAUSED") throw new HttpError(409, "invalid_transition", `${from} 不能恢复`);
      for (const mid of row.mandateIds) {
        const m = await this.d.mandates.byId(mid);
        if (m?.state === "PAUSED" && m.conditionsHash === row.conditionsHash) await this.d.mandates.transition(callerId, mid, "ACTIVE");
      }
      const resumed = await this.setStatus(row, "ACTIVE", "resumed by owner; re-evaluating");
      return { row: await this.evaluateTask(resumed, { issue: false }), note: "Resumed. Nothing is issued until conditions, evidence and quotes pass again." };
    }
    // cancel
    if (TASK_TERMINAL_STATUSES.has(from) || from === "REVOKE_PENDING") throw new HttpError(409, "invalid_transition", `${from} 不能取消`);
    let hadMandate = false;
    for (const mid of row.mandateIds) {
      const m = await this.d.mandates.byId(mid);
      if (m && ["ACTIVE", "PAUSED", "DRAFT"].includes(m.state)) {
        await this.d.mandates.transition(callerId, mid, "CANCELLED");
        hadMandate = true;
      }
    }
    await this.d.budget.release(row.id, "cancelled");
    const to: TaskStatus = hadMandate ? "REVOKE_PENDING" : "CANCELLED";
    return { row: await this.setStatus(row, to, hadMandate ? "cancelled service-side; waiting for on-chain revokeMandate confirmation" : "cancelled"), note: STOP_SEMANTICS_NOTE };
  }

  /** 链上 revokeMandate 确认（由回执核实器 / Lane C 调用）→ REVOKED，释放资金组 */
  async confirmRevoked(taskId: string, txHash: string): Promise<TaskRow | null> {
    const row = await this.byId(taskId);
    if (!row || row.status !== "REVOKE_PENDING") return null;
    await this.d.budget.release(row.id, "revoked");
    return this.setStatus(row, "REVOKED", `on-chain revoke confirmed ${txHash}`);
  }

  /* ---------------- 授权 ---------------- */

  async authorize(callerId: string, id: string, raw: unknown): Promise<{ row: TaskRow; mandate: Record<string, unknown> }> {
    const row = await this.requireTask(callerId, id);
    if (row.mode !== "LIVE") throw new HttpError(409, "simulation_task", "SIMULATION 任务不需要授权");
    if (!["AWAITING_AUTHORIZATION", "ACTIVE", "WAITING", "PARTIAL"].includes(row.status)) throw new HttpError(409, "invalid_transition", `${row.status} 不能授权`);
    const draft = row.mandateDraftJson as MandateDraft | null;
    if (!draft) throw new HttpError(409, "no_mandate_draft");
    const b = (raw ?? {}) as Record<string, unknown>;
    // F/SDK 形态：{ typedData, signature, outputSet, clientRequestId }；也接受 { mandate, signature }
    const fromTyped = b["typedData"] && typeof b["typedData"] === "object" ? ((b["typedData"] as { message?: unknown }).message ?? null) : null;
    const mandate = (b["mandate"] && typeof b["mandate"] === "object" ? b["mandate"] : (fromTyped ?? draft.mandate)) as TradeMandate;
    const body = { ...draft.registerBody, clientRequestId: typeof b["clientRequestId"] === "string" ? b["clientRequestId"] : `${row.id}:auth:${row.mandateIds.length}`, mandate, signature: b["signature"], conditionsHash: row.conditionsHash };
    if (mandate.effectivePolicyHash?.toLowerCase() !== draft.effectivePolicyHash.toLowerCase()) throw new HttpError(422, "mandate_rejected", "mandate.effectivePolicyHash 与任务当前条件（conditionsHash）不一致：改条件 = 新授权（K-09）", [{ field: "mandate.effectivePolicyHash", code: "conditions_hash_mismatch" }]);
    const r = await this.d.mandates.register(callerId, body, { taskId: row.id });
    const order = await this.d.orders.byRef(r.row.id);
    if (order && (order.priceUsd === "0" || this.d.orders.isDeliverable(order))) {
      await this.d.mandates.activate(r.row.id);
      if (order.state !== "DELIVERED") await this.d.orders.markDelivered(order.id);
    }
    const mrow = (await this.d.mandates.byId(r.row.id))!;
    const allocation = await this.d.budget.reserve({ owner: row.ownerAddress as EvmAddress, taskId: row.id, mandateId: mrow.id, budgetGroupId: row.budgetGroupId, inputAssetKey: (row.goalJson as PlanGoal).budget.inputAssetKeys[0]!, amountRaw: mrow.budgetCap, priority: (row.budgetAllocationJson as { priority?: number } | null)?.priority ?? 0, createdAt: this.now().toISOString(), mandateDeadline: mrow.deadline.toISOString(), mandateValidFrom: mrow.validFrom.toISOString() });
    const ids = row.mandateIds.includes(mrow.id) ? row.mandateIds : [...row.mandateIds, mrow.id];
    const timeline = [...(row.timelineJson as TimelineEntry[]), { at: this.now().toISOString(), type: "authorized", ref: mrow.id, note: `mandate ${mrow.id} ${mrow.state}` }];
    let updated = (await this.d.db.update(verifyTasks).set({ mandateIds: ids, budgetAllocationJson: allocation, timelineJson: timeline, updatedAt: this.now() }).where(eq(verifyTasks.id, row.id)).returning())[0]!;
    if (updated.status === "AWAITING_AUTHORIZATION" && mrow.state === "ACTIVE") updated = await this.setStatus(updated, "ACTIVE", `authorized: mandate ${mrow.id}`);
    updated = await this.evaluateTask(updated, { issue: false });
    return { row: updated, mandate: await this.d.mandates.view(mrow) };
  }

  /** K-09：改条件 = 新授权。旧授权服务侧暂停签发但不撤销；状态与「是否仍有可用证书」在 view.mandates 里展示 */
  async updateConditions(callerId: string, id: string, raw: unknown): Promise<TaskRow> {
    const row = await this.requireTask(callerId, id);
    if (TASK_TERMINAL_STATUSES.has(row.status as TaskStatus) || row.status === "REVOKE_PENDING") throw new HttpError(409, "invalid_transition", `${row.status} 不能改条件`);
    const def = playbookOf(this.d.playbooks, row.playbookId as PlaybookDefinition["id"]);
    const items = raw && typeof raw === "object" && Array.isArray((raw as { items?: unknown }).items) ? ((raw as { items: unknown[] }).items) : null;
    if (!items) throw new HttpError(400, "invalid_request", "需要 { items: Condition[] }");
    const mc = mergeConditions(def, row.paramsJson as Record<string, unknown>, items, row.mode as "LIVE" | "SIMULATION");
    if (!mc.ok) throw new HttpError(400, "invalid_conditions", "条件校验失败", mc.errors);
    const conditions = makeConditionSet([...mc.set.items.filter((i) => i.type !== "thesis_holds"), thesisHoldsCondition(row.thesisId!)]);
    if (conditions.hash === row.conditionsHash) return row;
    const goal = row.goalJson as PlanGoal;
    const nowDate = this.now();
    const { steps, perStepAmountRaw } = playbookBudget(def, row.paramsJson as Record<string, unknown>);
    const draft = row.mode === "LIVE" ? this.buildMandateDraft({ taskId: row.id, goal, conditions, steps: Math.max(1, steps - row.stepsConfirmed), perStepAmountRaw, nowSec: Math.floor(nowDate.getTime() / 1000), nonce: String(Math.floor(nowDate.getTime() / 1000)) }) : null;
    // 旧授权：服务侧停止签发（不是撤销）
    for (const mid of row.mandateIds) {
      const m = await this.d.mandates.byId(mid);
      if (m?.state === "ACTIVE") await this.d.mandates.transition(callerId, mid, "PAUSED");
    }
    const timeline = [...(row.timelineJson as TimelineEntry[]), { at: nowDate.toISOString(), type: "conditions_changed", note: `${row.conditionsHash} → ${conditions.hash}; previous mandates paused server-side (certificates already pulled may still execute until expiry; revoke on-chain to stop completely)` }];
    const [updated] = await this.d.db.update(verifyTasks).set({ conditionsJson: conditions, conditionsHash: conditions.hash, mandateDraftJson: draft, timelineJson: timeline, updatedAt: nowDate }).where(eq(verifyTasks.id, row.id)).returning();
    const to: TaskStatus = row.mode === "LIVE" ? "AWAITING_AUTHORIZATION" : (row.status as TaskStatus);
    const moved = row.mode === "LIVE" && row.status !== "AWAITING_AUTHORIZATION" ? await this.setStatus(updated!, to, "conditions changed: new authorization required") : updated!;
    return this.evaluateTask(moved, { issue: false });
  }

  /* ---------------- 评估（monitor 与 prepare-step 共用） ---------------- */

  private stockAndStable(goal: PlanGoal): { stockKey: string; stableKey: string } {
    const sell = goal.side === "sell";
    return { stockKey: sell ? goal.budget.inputAssetKeys[0]! : goal.legs[0]!.outputAssetKey, stableKey: sell ? goal.legs[0]!.outputAssetKey : goal.budget.inputAssetKeys[0]! };
  }

  private async taskState(row: TaskRow): Promise<TaskConditionState> {
    const goal = row.goalJson as PlanGoal;
    const { stockKey } = this.stockAndStable(goal);
    const stock = findEntry(this.d.registry, stockKey);
    const nowMs = this.now().getTime();
    const today = nyDateAt(nowMs);
    let stepsToday = 0;
    for (const mid of row.mandateIds) for (const s of await this.d.mandates.steps(mid)) if (s.state === "CONFIRMED" && nyDateAt(s.updatedAt.getTime()) === today) stepsToday++;
    const groupToday = row.budgetGroupId ? await this.d.budget.stepsConfirmedToday(row.budgetGroupId, today) : null;
    const def = playbookOf(this.d.playbooks, row.playbookId as PlaybookDefinition["id"]);
    const { perStepAmountRaw } = playbookBudget(def, row.paramsJson as Record<string, unknown>);
    return { underlyingIds: stock ? [stock.underlyingId] : [], outputAssetKeys: [stockKey], mode: row.mode as "LIVE" | "SIMULATION", lastConfirmedStepAt: row.lastConfirmedStepAt?.toISOString() ?? null, stepsConfirmedToday: stepsToday, stepsConfirmedTodayInBudgetGroup: groupToday, nextStepAmountRaw: perStepAmountRaw };
  }

  /** 组装条件证据：上下文 + 事件 + 余额（资金组）+ 理由卡 */
  private async conditionEvidence(row: TaskRow, st: TaskConditionState, thesis: { id: string; status: string; evidenceIds: string[] } | null): Promise<{ evidence: ConditionEvidence; records: EvidenceRecord[] }> {
    const ctx = await this.d.context.conditionEvidence(st.underlyingIds, undefined, { allowNonLive: row.mode === "SIMULATION" });
    const conditions = row.conditionsJson as ConditionSet;
    const balances: ConditionEvidence["balances"] = {};
    for (const c of conditions.items) {
      if (c.type !== "cash_floor") continue;
      const b = await this.d.budget.cashFloor(row.ownerAddress as EvmAddress, c.inputAssetKey);
      if (b) balances[c.inputAssetKey] = b;
    }
    const theses: ConditionEvidence["theses"] = thesis ? { [thesis.id]: { status: thesis.status as ConditionEvidence["theses"][string]["status"], evidenceIds: thesis.evidenceIds } } : {};
    return { evidence: { context: ctx.context, events: ctx.events, earningsCoverage: ctx.earningsCoverage, quote: null, balances, trackedCost: {}, theses }, records: ctx.records };
  }

  private quoteFromReport(report: VerifyReport): NonNullable<ConditionEvidence["quote"]> {
    return { evidenceIds: report.evidenceIds, executableUsdPerShare: report.normalizedQuote?.executableUsdPerShare ?? null, referencePriceUsd: report.reference?.priceUsd ?? null, referenceKind: report.reference?.kind ?? null, premiumBps: report.reference?.deviationBps ?? null };
  }

  /** 步骤任务（SIMULATION 取证用；与 mandates.nextStepJob 同形） */
  private stepJob(row: TaskRow): { job: NormalizedJob; policy: EffectivePolicy } {
    const goal = row.goalJson as PlanGoal;
    const def = playbookOf(this.d.playbooks, row.playbookId as PlaybookDefinition["id"]);
    const { perStepAmountRaw } = playbookBudget(def, row.paramsJson as Record<string, unknown>);
    const pdef = findPolicy(goal.policyId, goal.policyVersion)!;
    const resolved = resolveParams(pdef, { maxSlippageBps: goal.maxSlippageBps, maxPriceImpactBps: goal.maxPriceImpactBps, maxReferenceDeviationBps: goal.policyId === "QUOTE_ONLY" ? null : (goal.maxReferenceDeviationBps ?? null) });
    if (!resolved.ok) throw new HttpError(400, "policy_param_out_of_range");
    const policy = policyWithConditions(pdef, resolved.params, row.conditionsHash as `0x${string}`);
    const job: NormalizedJob = { clientRequestId: `${row.id}:sim:${row.stepsConfirmed}`, ownerAddress: goal.ownerAddress, recipientAddress: goal.recipientAddress, executionChainId: goal.executionChainId, inputAssetKey: goal.budget.inputAssetKeys[0]!, outputAssetKey: goal.legs[0]!.outputAssetKey, amountInRaw: perStepAmountRaw, mode: "exactIn", policyId: goal.policyId, policyVersion: goal.policyVersion, params: policy.params, ...(goal.side === "sell" ? { side: "sell" as const } : {}) };
    return { job, policy };
  }

  /**
   * 一次评估：理由卡 → 条件（无报价快路径）→ [LIVE] 授权层评估 + 条件闸门（含报价）/ [SIMULATION] 取证 + 条件（含报价）
   * → 阻塞项全量 → 状态与 nextCheckAt 写回；阻塞集合变化才写 verify_task_blockers + task.blocked。
   * issue=false：只评估不签发（建任务 / 授权后 / 恢复后）；issue=true：prepare-step 与 monitor（ACTIVE 且条件通过才签发）。
   */
  async evaluateTask(row0: TaskRow, opts: { issue: boolean }): Promise<TaskRow> {
    const row = (await this.byId(row0.id)) ?? row0;
    if (!TASK_MONITORED_STATUSES.has(row.status as TaskStatus) && row.status !== "AWAITING_AUTHORIZATION") return row;
    const nowDate = this.now();
    const nowIso = nowDate.toISOString();
    if (row.deadline.getTime() < nowDate.getTime()) {
      await this.d.budget.release(row.id, "expired");
      return this.setStatus(row, "EXPIRED", "deadline passed");
    }
    const st = await this.taskState(row);
    const conditions = row.conditionsJson as ConditionSet;

    // 理由卡：先重评机器前提（它的证据与条件层同源）。含报价类前提（premium/target/tracked_cost）的卡在拿到报价后再评一次。
    let thesisInfo: { id: string; status: string; evidenceIds: string[]; action: string | null } | null = null;
    let thesisRow: ThesisRow | null = row.thesisId ? await this.d.theses.byId(row.thesisId) : null;
    const base = await this.conditionEvidence(row, st, null);
    const thesisNeedsQuote = !!thesisRow && (thesisRow.premisesJson as Array<{ kind: string; condition?: { type: Condition["type"] } }>).some((p) => p.kind === "machine" && p.condition && QUOTE_DEPENDENT_CONDITION_TYPES.has(p.condition.type));
    const runThesis = async (evidence: ConditionEvidence): Promise<void> => {
      if (!thesisRow) return;
      const { result, row: updatedThesis } = await this.d.theses.runCheck(thesisRow, evidence, st);
      thesisRow = updatedThesis;
      let action: string | null = null;
      if (result.newlyInvalidated.length > 0) action = await this.applyThesisAction(row, updatedThesis, result.newlyInvalidated);
      if (result.newlyExpired) {
        await this.d.notifier.emit(notificationPayload("thesis.unknown", updatedThesis.id, 1, "thesis validUntil passed: renew or end the task", `/agent/tasks/${row.id}`, nowIso), row.ownerAddress);
        action = action ?? "expired";
      }
      if (action) await this.d.theses.recordAction(updatedThesis.id, action);
      thesisInfo = { id: updatedThesis.id, status: updatedThesis.status, evidenceIds: result.evidenceIds, action: action ?? thesisInfo?.action ?? null };
      evidence.theses = { [updatedThesis.id]: { status: updatedThesis.status as ConditionEvidence["theses"][string]["status"], evidenceIds: result.evidenceIds } };
    };
    await runThesis(base.evidence);
    // pause_issuance 可能已把任务改成 PAUSED：重读
    const cur = (await this.byId(row.id)) ?? row;

    // 快路径：不含报价的条件先算；不通过就不取报价、不签发。理由卡因报价类前提暂 unknown 的不算快路径阻塞（拿到报价再定）
    const pre = evaluateConditions(conditions, base.evidence, st, nowIso);
    const preBlocked = pre.perItem.some((p) => p.outcome !== "SATISFIED" && !QUOTE_DEPENDENT_CONDITION_TYPES.has(p.item.type) && !(p.item.type === "thesis_holds" && thesisNeedsQuote && p.outcome === "INSUFFICIENT_EVIDENCE"));
    const needsQuote = conditions.items.some((c) => QUOTE_DEPENDENT_CONDITION_TYPES.has(c.type));
    let finalEval: ConditionEvaluation = pre;
    let evidenceForRecord: ConditionEvidence = base.evidence;
    let mandateInfo: LastEvaluation["mandate"] = null;
    let simulation: LastEvaluation["simulation"] = null;
    let mandateReasons: Reason[] = [];
    let stepIssued = false;
    let quoteFetched = false;
    let completed = false;
    let quoteRecords: EvidenceRecord[] = [];
    const stepsDoneBefore = cur.stepsConfirmed;

    let postEarningsBlockers: Blocker[] = [];
    const activeMandate = await this.currentMandate(cur);
    if (cur.mode === "LIVE") {
      if (!activeMandate) {
        // 尚未授权：只报条件层结果
        mandateReasons = cur.status === "AWAITING_AUTHORIZATION" ? [{ code: "AWAITING_USER_SIGNATURE", severity: "info", evidenceIds: [], detail: { reason: "no active mandate for current conditions" } }] : [];
      } else if (!preBlocked) {
        // 授权层评估 + 条件闸门（用本轮报价/参考价重算全部条件；不过 → 不签发）。PAUSED：mandate 也是 PAUSED，evaluate 照常评估但不签发（M-14）
        const gate = async (g: EvaluateGateInput) => {
          const ev: ConditionEvidence = { ...base.evidence, quote: this.quoteFromReport(g.report) };
          if (thesisNeedsQuote) await runThesis(ev);
          const full = evaluateConditions(conditions, ev, st, g.nowIso);
          finalEval = full;
          evidenceForRecord = ev;
          quoteFetched = true;
          quoteRecords = g.evidence;
          // E-06（Lane D 闸门）：财报窗口计时结束 ≠ 可以买——参考价须恢复实时、报价冲击须在上限内；两个原因都列
          const post = this.postEarnings(conditions, base.evidence, g.report, g.nowIso);
          const reasons = [...full.perItem.flatMap((p) => (p.outcome === "SATISFIED" ? [] : p.reasons)), ...post.reasons];
          postEarningsBlockers = post.blockers;
          return { ok: full.outcome === "SATISFIED" && post.blockers.length === 0, reasons, nextCheckAt: full.nextCheckAt ?? post.nextCheckAt };
        };
        const { evaluation, step } = await this.d.mandates.evaluate(activeMandate, { gate, issue: opts.issue });
        mandateReasons = (evaluation.reasonsJson as Reason[]).filter((r) => r.severity === "block" || INFO_ONLY_CODES.has(r.code));
        mandateInfo = { mandateId: activeMandate.id, status: evaluation.status, reasons: evaluation.reasonsJson as Reason[], preparedStepIndex: evaluation.preparedStepIndex };
        stepIssued = evaluation.status === "READY" && !!step && step.state === "PREPARED";
        const m = await this.d.mandates.byId(activeMandate.id);
        completed = m?.state === "COMPLETED" || evaluation.status === "DONE";
      }
    } else if (!preBlocked && needsQuote) {
      // SIMULATION：真实取证与规则，不签证书不执行
      try {
        const { job, policy } = this.stepJob(cur);
        const collected = await this.d.evidence.collect(job, this.d.registry, nowIso);
        const report = buildReport({ jobId: cur.id, reportVersion: 1, job, policy, registry: this.d.registry, evidence: collected.evidence, evaluatedAt: nowIso });
        const ev: ConditionEvidence = { ...base.evidence, quote: this.quoteFromReport(report) };
        if (thesisNeedsQuote) await runThesis(ev);
        finalEval = evaluateConditions(conditions, ev, st, nowIso);
        evidenceForRecord = ev;
        quoteFetched = true;
        quoteRecords = collected.evidence;
        postEarningsBlockers = this.postEarnings(conditions, base.evidence, report, nowIso).blockers;
        simulation = { wouldIssue: finalEval.outcome === "SATISFIED" && report.executionEligible, reportVerdict: report.verdict, reasons: report.reasons.filter((r) => r.severity === "block") };
        mandateReasons = report.reasons.filter((r) => r.severity === "block");
      } catch (err) {
        simulation = { wouldIssue: false, reportVerdict: null, reasons: [{ code: "QUOTE_UNAVAILABLE", severity: "block", evidenceIds: [], detail: { error: err instanceof Error ? err.message.slice(0, 200) : String(err) } }] };
        mandateReasons = simulation.reasons;
      }
    } else if (!preBlocked) {
      simulation = { wouldIssue: true, reportVerdict: null, reasons: [] };
    }

    // 阻塞项全量（条件层 + 授权/报价层），信息项单列不阻塞
    const blockers: Blocker[] = blockersFromEvaluation(finalEval, base.evidence.context?.receivedAt ?? null);
    for (const r of mandateReasons) if (r.severity === "block") blockers.push(blockerFromReason(r, nowIso, WAIT_NEXT_REGULAR.has(r.code) ? new Date(nextRegularOpenMs(nowDate.getTime())).toISOString() : null));
    for (const b of postEarningsBlockers) if (!blockers.some((x) => x.code === b.code)) blockers.push(b);
    const info: Blocker[] = mandateReasons.filter((r) => r.severity === "info").map((r) => blockerFromReason(r, nowIso, null));
    const nexts = [finalEval.nextCheckAt, ...blockers.map((b) => b.nextCheckAt)].filter((x): x is string => !!x).map((x) => Date.parse(x)).filter((x) => x > nowDate.getTime());
    const nextCheckAt = nexts.length ? new Date(Math.min(...nexts)) : null;
    const mandateBlocked = mandateReasons.some((r) => r.severity === "block") || postEarningsBlockers.length > 0;
    const status = cur.status === "AWAITING_AUTHORIZATION" ? "AWAITING_AUTHORIZATION" : runningStatusAfterEvaluation({ current: cur.status as TaskStatus, outcome: finalEval.outcome, mandateBlocked, stepIssued, stepsDone: stepsDoneBefore, completed });

    const thesisOut = thesisInfo as { id: string; status: string; evidenceIds: string[]; action: string | null } | null;
    const last: LastEvaluation = { evaluatedAt: nowIso, outcome: finalEval.outcome, conditionsHash: finalEval.conditionsHash, perItem: finalEval.perItem, nextCheckAt: nextCheckAt?.toISOString() ?? null, mandate: mandateInfo, simulation, thesis: thesisOut ? { thesisId: thesisOut.id, status: thesisOut.status, action: thesisOut.action } : null, quoteFetched };
    const record: ConditionEvaluationRecord = { input: { set: conditions, evidence: evidenceForRecord, taskState: st, now: finalEval.evaluatedAt }, output: finalEval };
    const key = blockerSetKey(blockers);
    const lastBlocker = (await this.d.db.select().from(verifyTaskBlockers).where(eq(verifyTaskBlockers.taskId, cur.id)).orderBy(desc(verifyTaskBlockers.evaluatedAt)).limit(1))[0];
    if (!lastBlocker || lastBlocker.blockerSetKey !== key) {
      await this.d.db.insert(verifyTaskBlockers).values({ taskId: cur.id, evaluatedAt: nowDate, outcome: finalEval.outcome, blockersJson: blockers, blockerSetKey: key, nextCheckAt, evaluationJson: record, recordsJson: [...base.records, ...quoteRecords] });
      if (blockers.length > 0) await this.d.notifier.emit(notificationPayload("task.blocked", cur.id, (lastBlocker?.id ?? 0) + 1, `blocked: ${[...new Set(blockers.map((b) => b.code))].join(", ")}`, `/agent/tasks/${cur.id}`, nowIso), cur.ownerAddress);
    }
    if (stepIssued) await this.d.notifier.emit(notificationPayload("task.step_ready", cur.id, (mandateInfo?.preparedStepIndex ?? 0) + 1, `step ${mandateInfo?.preparedStepIndex ?? "?"} certificate issued`, `/agent/tasks/${cur.id}`, nowIso), cur.ownerAddress);
    const extra = { blockersJson: [...blockers, ...info], nextCheckAt, lastEvaluationJson: last, ...(status === "COMPLETED" ? {} : {}) };
    if (status !== cur.status) return this.setStatus(cur, status, `evaluated: ${finalEval.outcome}${mandateInfo ? ` / mandate ${mandateInfo.status}` : ""}`, extra);
    const [updated] = await this.d.db.update(verifyTasks).set({ ...extra, updatedAt: nowDate }).where(eq(verifyTasks.id, cur.id)).returning();
    return updated ?? cur;
  }

  /** E-06：财报后双原因闸门（Lane D postEarningsGate）——只对「已发生且窗口刚结束」的相关财报事件生效 */
  private postEarnings(conditions: ConditionSet, evidence: ConditionEvidence, report: VerifyReport, nowIso: string): { blockers: Blocker[]; reasons: Reason[]; nextCheckAt: string | null } {
    const cond = conditions.items.find((c): c is Extract<Condition, { type: "earnings_window" }> => c.type === "earnings_window");
    if (!cond) return { blockers: [], reasons: [], nextCheckAt: null };
    const nowMs = Date.parse(nowIso);
    const blockers: Blocker[] = [];
    let next: string | null = null;
    for (const { event, evidenceId } of evidence.events) {
      if (event.kind !== "EARNINGS" || event.status === "cancelled") continue;
      const at = Date.parse(event.scheduledAtUtc ?? `${event.dateLocal}T00:00:00.000Z`);
      if (!(at <= nowMs && nowMs - at <= 10 * 86_400_000)) continue;
      const g = postEarningsGate({
        event,
        condition: cond,
        nowIso,
        session: report.marketSession,
        reference: report.reference ? { status: report.reference.kind === "live" ? "live" : "close", observedAt: report.reference.sourcePublishedAt, evidenceId } : { status: "missing", observedAt: null },
        quote: report.normalizedQuote ? { status: "ok", priceImpactBps: report.normalizedQuote.adverseImpactBps } : { status: "unavailable", priceImpactBps: null },
        maxPriceImpactBps: report.policySnapshot.params.maxPriceImpactBps ?? 10_000,
      });
      if (g.outcome !== "SATISFIED") {
        blockers.push(...g.blockers);
        if (g.nextCheckAt && (!next || g.nextCheckAt < next)) next = g.nextCheckAt;
      }
    }
    return { blockers, reasons: blockers.map((b) => ({ code: b.code, severity: "block" as const, evidenceIds: b.evidenceIds, detail: { source: "post_earnings_gate" } })), nextCheckAt: next };
  }

  /** 当前条件对应的可用授权（conditionsHash 一致且 ACTIVE/PAUSED） */
  private async currentMandate(row: TaskRow): Promise<MandateRow | null> {
    for (const id of [...row.mandateIds].reverse()) {
      const m = await this.d.mandates.byId(id);
      if (m && m.conditionsHash === row.conditionsHash && (m.state === "ACTIVE" || m.state === "PAUSED")) return m;
    }
    return null;
  }

  /* ---------------- prepare-step ---------------- */

  async prepareStep(callerId: string, id: string): Promise<{ httpStatus: 200 | 409; body: Record<string, unknown> }> {
    const row0 = await this.requireTask(callerId, id);
    if (row0.status === "PAUSED") return { httpStatus: 409, body: { status: "WAIT", taskId: id, taskStatus: "PAUSED", blockers: row0.blockersJson, nextCheckAt: row0.nextCheckAt?.toISOString() ?? null, message: "task is paused; no step certificate is issued while paused", stopSemantics: STOP_SEMANTICS_NOTE } };
    if (row0.status === "AWAITING_AUTHORIZATION") {
      const row = await this.evaluateTask(row0, { issue: false });
      return { httpStatus: 409, body: { status: "WAIT", taskId: id, taskStatus: row.status, blockers: row.blockersJson, nextCheckAt: row.nextCheckAt?.toISOString() ?? null, mandateDraft: row.mandateDraftJson, message: "sign the mandate draft and POST /v1/tasks/:id/authorize first", lastEvaluation: row.lastEvaluationJson } };
    }
    if (!TASK_RUNNING_STATUSES.has(row0.status as TaskStatus)) throw new HttpError(409, "task_not_active", `任务状态 ${row0.status}`);
    if (!this.d.cfg.agentC2) throw new HttpError(503, "agent_c2_disabled", "条件层已关闭（AGENT_C2_ENABLED=false）：不签发");
    const row = await this.evaluateTask(row0, { issue: true });
    const last = row.lastEvaluationJson as LastEvaluation | null;
    if (row.mode === "SIMULATION") {
      const ok = last?.outcome === "SATISFIED" && (last.simulation?.wouldIssue ?? false);
      return { httpStatus: ok ? 200 : 409, body: { status: ok ? "READY" : "WAIT", mode: "SIMULATION", taskId: id, taskStatus: row.status, blockers: row.blockersJson, nextCheckAt: row.nextCheckAt?.toISOString() ?? null, evaluation: last, certificate: null, note: "Simulation: conditions and rules ran on real evidence; no certificate was signed and nothing was executed." } };
    }
    if (row.status === "STEP_PREPARED" && last?.mandate) {
      const p = await this.d.mandates.prepareStep(callerId, last.mandate.mandateId);
      if (p.status === "READY") {
        // 证书被拉走 = 在途占用（资金组 C8）
        await this.d.budget.markPending(last.mandate.mandateId, p.stepIndex, (p.step as { amountIn: string }).amountIn).catch((err) => log.warn("markPending 失败", { error: err instanceof Error ? err.message : String(err) }));
        return { httpStatus: 200, body: { ...p, taskId: id, taskStatus: row.status, conditionsHash: row.conditionsHash, conditionEvaluation: { outcome: last.outcome, perItem: last.perItem }, blockers: row.blockersJson, nextCheckAt: null, stopSemantics: STOP_SEMANTICS_NOTE } };
      }
      const again = await this.evaluateTask(row, { issue: false });
      return { httpStatus: 409, body: { status: p.status, taskId: id, taskStatus: again.status, blockers: again.blockersJson, nextCheckAt: again.nextCheckAt?.toISOString() ?? null, evaluation: again.lastEvaluationJson } };
    }
    return { httpStatus: 409, body: { status: "WAIT", taskId: id, taskStatus: row.status, blockers: row.blockersJson, nextCheckAt: row.nextCheckAt?.toISOString() ?? null, evaluation: last, stopSemantics: STOP_SEMANTICS_NOTE } };
  }

  /* ---------------- 步骤确认 / 理由卡动作 ---------------- */

  async onStepConfirmed(a: { mandateId: string; taskId: string | null; stepIndex: number; spentRaw: string; confirmedAt: Date }): Promise<void> {
    if (!a.taskId) return;
    const row = await this.byId(a.taskId);
    if (!row) return;
    await this.d.budget.onStepConfirmed(row.id, a.spentRaw);
    const stepsConfirmed = row.stepsConfirmed + 1;
    const timeline = [...(row.timelineJson as TimelineEntry[]), { at: a.confirmedAt.toISOString(), type: "step_confirmed", ref: `${a.mandateId}:${a.stepIndex}`, note: `spent ${a.spentRaw}` }];
    const done = stepsConfirmed >= row.stepsPlanned;
    const [updated] = await this.d.db.update(verifyTasks).set({ stepsConfirmed, lastConfirmedStepAt: a.confirmedAt, timelineJson: timeline, updatedAt: this.now() }).where(eq(verifyTasks.id, row.id)).returning();
    await this.d.notifier.emit(notificationPayload("task.step_confirmed", row.id, stepsConfirmed, `step ${a.stepIndex} confirmed`, `/agent/tasks/${row.id}`, a.confirmedAt.toISOString()), row.ownerAddress);
    if (updated && (TASK_RUNNING_STATUSES.has(updated.status as TaskStatus) || updated.status === "PAUSED")) {
      if (done) {
        await this.d.budget.release(row.id, "completed");
        await this.setStatus(updated, "COMPLETED", `all ${row.stepsPlanned} steps confirmed`);
      } else if (updated.status !== "PAUSED") await this.setStatus(updated, "PARTIAL", `${stepsConfirmed}/${row.stepsPlanned} steps confirmed`);
    }
  }

  /** 理由卡机器前提失效 → onInvalidation 三路径（notify / pause_issuance / draft_exit）；都不越权：不卖、不改授权 */
  async applyThesisAction(row: TaskRow, thesis: ThesisRow, invalidated: string[]): Promise<string> {
    const action = thesis.onInvalidation as ThesisOnInvalidation;
    const nowIso = this.now().toISOString();
    await this.d.notifier.emit(notificationPayload("thesis.invalidated", thesis.id, invalidated.length, `premises invalidated: ${invalidated.join(", ")}; action=${action}`, `/agent/tasks/${row.id}`, nowIso), row.ownerAddress);
    if (action === "pause_issuance") {
      const cur = (await this.byId(row.id)) ?? row;
      if (TASK_RUNNING_STATUSES.has(cur.status as TaskStatus)) {
        for (const mid of cur.mandateIds) {
          const m = await this.d.mandates.byId(mid);
          if (m?.state === "ACTIVE") await this.d.mandates.transition(cur.callerId, mid, "PAUSED");
        }
        await this.setStatus(cur, "PAUSED", "thesis invalidated → pause_issuance (service-side: stops issuance only; pulled unexpired certificates may still execute)");
      }
      return "pause_issuance";
    }
    if (action === "draft_exit") {
      const draft = await this.buildExitDraft(row);
      await this.d.db.update(verifyTasks).set({ exitDraftJson: draft, timelineJson: [...(row.timelineJson as TimelineEntry[]), { at: nowIso, type: "exit_draft", note: "thesis invalidated → sell draft generated; requires a NEW authorization (nothing is sold automatically)" }], updatedAt: this.now() }).where(eq(verifyTasks.id, row.id));
      return "draft_exit";
    }
    return "notify";
  }

  /** 退出草案：卖出同一股票代币（数量 = 已确认步数 × 每步预算的估算；用户须重新授权） */
  private async buildExitDraft(row: TaskRow): Promise<Record<string, unknown>> {
    const goal = row.goalJson as PlanGoal;
    const { stockKey, stableKey } = this.stockAndStable(goal);
    const stock = findEntry(this.d.registry, stockKey)!;
    const stable = findEntry(this.d.registry, stableKey)!;
    const exitGoal: PlanGoal = { ...goal, side: "sell", legs: [{ outputAssetKey: stable.assetKey, weightBps: 10_000 }], budget: { inputAssetKeys: [stock.assetKey], amountInRaw: "0" }, deadline: goal.deadline };
    return { kind: "sell_draft", createdAt: this.now().toISOString(), goal: exitGoal, note: "Draft only. The amount (stock tokens held) must be filled from the portfolio (Lane C) and the owner must sign a new TradeMandate; nothing is executed automatically.", requiresNewAuthorization: true, playbookHint: "target_sell" };
  }

  /** 手动触发理由卡检查（POST /v1/theses/:id/check）：走一次任务评估（不签发） */
  async checkThesis(callerId: string, thesisId: string): Promise<{ task: TaskRow; thesis: ThesisRow }> {
    const t = await this.d.theses.require(callerId, thesisId);
    const row = await this.requireTask(callerId, t.taskId);
    const updated = await this.evaluateTask(row, { issue: false });
    return { task: updated, thesis: (await this.d.theses.byId(thesisId))! };
  }

  /* ---------------- monitor ---------------- */

  /** 撤销确认用：所有 REVOKE_PENDING 的任务（Lane I `tasks/revocations.ts` 每 tick 查链上 MandateRevoked） */
  async revokePendingTasks(): Promise<TaskRow[]> {
    return this.d.db.select().from(verifyTasks).where(eq(verifyTasks.status, "REVOKE_PENDING"));
  }

  async monitoredTasks(): Promise<TaskRow[]> {
    return this.d.db.select().from(verifyTasks).where(inArray(verifyTasks.status, [...TASK_MONITORED_STATUSES]));
  }
  async expireTasks(): Promise<number> {
    const now = this.now();
    const rows = await this.d.db.select().from(verifyTasks).where(and(inArray(verifyTasks.status, ["DRAFT", "AWAITING_AUTHORIZATION", ...TASK_MONITORED_STATUSES]), lt(verifyTasks.deadline, now)));
    for (const r of rows) {
      await this.d.budget.release(r.id, "expired");
      await this.setStatus(r, "EXPIRED", "deadline passed").catch(() => undefined);
    }
    return rows.length;
  }
  async blockerHistory(taskId: string, limit = 50) {
    return this.d.db.select().from(verifyTaskBlockers).where(eq(verifyTaskBlockers.taskId, taskId)).orderBy(desc(verifyTaskBlockers.evaluatedAt)).limit(limit);
  }
}
