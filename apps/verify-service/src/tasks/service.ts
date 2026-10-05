/**
 * 任务（C3，interfaces §11.5–11.7）：playbook + 参数 → PlanGoal → 规划候选 → 授权草案 → 资金组分配 → 理由卡；
 * 12 态状态机；prepare-step 前置链 = evaluateConditions → 资金组/现金下限 → 理由卡 → 现有 mandates.prepareStep（证据、报价、证书 TTL 规则不变）。
 * 绑定哈希进 effectivePolicyHash 展开参数 → 证书与证据包（K-10）。CV-D16（scope/1）：绑定哈希 = scopeHash（授权范围：
 * 目标 / 资产集合 / 总额 / 每笔上限 / 期限 / 允许卖出 / 信任档位 / 签发方式 / 硬约束），计划条件与模板参数在签名之外可改不重签；
 * 旧任务（scope_json 为空）绑定的仍是 conditionsHash。停止语义 D-088：服务侧只阻止后续签发。
 */
import { and, desc, eq, inArray, isNull, lt } from "drizzle-orm";
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
  sessionLabelAtMs,
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
  REPEATABLE_CONDITION_TYPES,
  resolveTaskScope,
  scopeHash as computeScopeHash,
  mergeHardConditions,
  touchesHardConditions,
  resolveAgentStatusReport,
  resolveTurnBinding,
  eventDueAtMs,
  eventObservationKey,
  AGENT_TURN_RESPOND_MS,
  DEFAULT_WATCH_KINDS,
  EVENT_WATCH_AHEAD_MS,
  EVENT_WATCH_PAST_MS,
  STRATEGY_MAX_CHARS,
  EVENT_KINDS,
  isRawAmount,
  type TaskBrief,
  type TurnBinding,
  type AgentStatusReport,
  type StrategyVersion,
  type AgentTurn,
  type AgentTurnReason,
  type TaskScope,
  type Bytes32,
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
  type MarketEvent,
  type Actor,
} from "@chaconne/core/verify";
import type { VerifyConfig } from "../config";
import type { EvidenceProvider } from "../evidence/provider";
import { newId } from "../ids";
import { log } from "../log";
import { HttpError } from "../jobs/service";
import { callerActsFor, isServiceCallerId } from "../http/auth";
import { decideTurnAction, isTerminalIntentStatus, type RecordedTurnAction } from "@chaconne/core/verify/agent/index";
import { currentRunBinding } from "../agent/runContext";
import { hostedTurnState, recordHostedTurnAction } from "../agent/turns";
import { MandatesService, policyWithConditions, type EvaluateGateInput, type MandateRow } from "../mandates/service";
import type { Orders } from "../payments/orders";
import type { PlanEngine } from "../plans/engine";
import type { ContextService } from "../context/service";
import type { ThesesService, ThesisRow } from "../theses/service";
import type { BudgetCoordinator } from "./budget";
import { notificationPayload, type TaskNotifier } from "./notify";
import { playbookOf } from "./playbooks";
import { postEarningsGate } from "../impacts/postEarningsWait";
import { IntentsService } from "./intents";
import { isDelegationTask, type TasksV7Hooks } from "./runtime";
import { actorOf, appendTimeline } from "../records/timeline";

export type TaskRow = typeof verifyTasks.$inferSelect;

/**
 * v7（D-093 / §2.9）：任务操作的权限类别。
 *  read        = 读任务及其派生视图
 *  agent_write = 意图（提交 / 撤回）、agent-status（策略与计划修订都经它）、memory、quotes、理由卡 review-items
 *  owner_write = 授权、额度、委托刷新、接管切换、暂停 / 恢复 / 取消 / 删除、简报、计划条件、分享（缺省）
 * agent:hosted 只在 row.agentMode = hosted 且轮次令牌绑定本任务时允许 read / agent_write；永远不能 owner_write。
 */
export type TaskOp = "read" | "agent_write" | "owner_write";

/** 绑定哈希：签名折入 effectivePolicyHash 的那个 bytes32（scope/1 任务 = scopeHash；旧任务 = conditionsHash） */
export function bindingHashOf(row: Pick<TaskRow, "scopeHash" | "conditionsHash">): Bytes32 {
  return (row.scopeHash ?? row.conditionsHash) as Bytes32;
}
/** Agent 回报 declined / needs_evidence 但没给 nextCheckAt 时的缺省复查间隔（= verify-agent FALLBACK_NEXT_CHECK_MS） */
/** Agent 报告写进时间线的上限：note 本身最多 1000 字（agentTurn 校验）+ wants / 下次检查后缀；原来 500 会把原话截断（10/4 走查） */
const AGENT_REPORT_NOTE_MAX = 2000;
export const AGENT_DEFAULT_NEXT_CHECK_MS = 15 * 60_000;

export function scopeOf(row: Pick<TaskRow, "scopeJson">): TaskScope | null {
  return (row.scopeJson as TaskScope | null) ?? null;
}
/** 边界说明（写进视图与 MCP 摘要，不夸大）：PlanGuard 只约束经该合约的交易 */
export const SCOPE_BOUNDARY_NOTE = "The signed scope (assets, budget, per-step cap, steps, deadline, hard constraints) is enforced by PlanGuard for every step that goes through the contract. It does not constrain transactions an agent sends from a wallet whose full private key it holds outside PlanGuard.";

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

export interface TimelineEntry {
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
  /** 绑定哈希（= scopeHash；字段名沿用 K-10 的展开参数名） */
  conditionsHash: string;
  scopeHash: string | null;
  effectivePolicyHash: string;
  policyDefinitionHash: string;
  registerBody: Record<string, unknown>;
  note: string;
}
export interface LastEvaluation {
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
  /** CV-D16 批次 2：agent 交易意图（同一份依赖） */
  readonly intents: IntentsService;
  constructor(private readonly d: TasksDeps) {
    this.now = d.now ?? (() => new Date());
    d.mandates.setStepConfirmedListener((a) => this.onStepConfirmed(a));
    this.intents = new IntentsService(this, d, this.now);
  }
  /** @internal */
  get deps(): TasksDeps {
    return this.d;
  }
  /* v7（Lane X）：委托 / 执行钩子；未装配 = v6 行为 */
  private v7: TasksV7Hooks | null = null;
  private nonceSeq = 0;
  setV7Hooks(h: TasksV7Hooks | null): void {
    this.v7 = h;
  }
  get v7Hooks(): TasksV7Hooks | null {
    return this.v7;
  }

  /* ---------------- 鉴权 / 读取 ---------------- */

  ownerOf(callerId: string, bodyOwner?: unknown): EvmAddress {
    // SEC-09：服务 key 不代表任何 owner，不信任它给的 body owner
    if (isServiceCallerId(callerId)) throw new HttpError(403, "service_caller_not_owner", "service callers cannot act for an owner");
    const m = callerId.match(/(0x[0-9a-f]{40})$/);
    if (m) return m[1] as EvmAddress;
    if (typeof bodyOwner === "string" && isEvmAddress(bodyOwner)) return normalizeAddress(bodyOwner);
    throw new HttpError(400, "owner_required", "该调用方需要在请求体给出 ownerAddress");
  }
  /** @internal 窄更新（意图服务用） */
  async patch(id: string, set: Partial<typeof verifyTasks.$inferInsert>): Promise<TaskRow | undefined> {
    return (await this.d.db.update(verifyTasks).set(set).where(eq(verifyTasks.id, id)).returning())[0];
  }
  async byId(id: string): Promise<TaskRow | null> {
    return (await this.d.db.select().from(verifyTasks).where(eq(verifyTasks.id, id)).limit(1))[0] ?? null;
  }
  async requireTask(callerId: string, id: string, op: TaskOp = "owner_write"): Promise<TaskRow> {
    const row = await this.byId(id);
    if (isServiceCallerId(callerId)) {
      // CV-D25：托管 Agent 只对令牌绑定的、agent_mode=hosted 的任务做 read / agent_write；执行身份不走任务接口
      const b = currentRunBinding();
      if (callerId !== "agent:hosted" || op === "owner_write" || !row || row.agentMode !== "hosted" || !b || b.taskId !== row.id) throw new HttpError(403, "task_forbidden", "任务不存在或不属于该调用方");
      return row;
    }
    if (!row || (row.callerId !== callerId && !callerActsFor(callerId, row.ownerAddress))) throw new HttpError(403, "task_forbidden", "任务不存在或不属于该调用方");
    return row;
  }
  async list(callerId: string, owner?: string): Promise<TaskRow[]> {
    const rows = await this.d.db.select().from(verifyTasks).where(and(eq(verifyTasks.callerId, callerId), isNull(verifyTasks.archivedAt))).orderBy(desc(verifyTasks.createdAt)).limit(200);
    return owner ? rows.filter((r) => r.ownerAddress === owner.toLowerCase()) : rows;
  }

  /**
   * 用户删除 = 归档（批次 7）：运行中的先按 D-088 取消（服务侧停止签发；有授权则进 REVOKE_PENDING 等链上撤销确认），
   * 然后从列表与记录里消失；行、授权、证书、回执都不销毁，详情仍可打开。
   */
  async archive(callerId: string, id: string): Promise<{ row: TaskRow; cancelled: boolean; note: string }> {
    let row = await this.requireTask(callerId, id);
    let cancelled = false;
    if (!TASK_TERMINAL_STATUSES.has(row.status as TaskStatus) && row.status !== "REVOKE_PENDING") {
      row = (await this.transition(callerId, id, "cancel")).row;
      cancelled = true;
    }
    const now = this.now();
    row = (await this.patch(row.id, { archivedAt: now, updatedAt: now })) ?? row;
    row = (await appendTimeline(this.d.db, row.id, { at: now.toISOString(), type: "archived", note: cancelled ? "deleted by owner (cancelled first)" : "deleted by owner" }, actorOf(callerId))).row ?? row;
    return { row, cancelled, note: row.status === "REVOKE_PENDING" ? "removed from your lists; the on-chain authorization is still pending revocation (D-088): pulled certificates may execute until they expire, revoke on-chain to stop completely" : "removed from your lists; records and evidence are kept" };
  }
  /** 跨调用方按 owner 读（Lane D 影响清单 / 修订传播：只读，不含私密字段） */
  async listByOwner(owner: string): Promise<TaskRow[]> {
    return this.d.db.select().from(verifyTasks).where(eq(verifyTasks.ownerAddress, owner.toLowerCase())).orderBy(desc(verifyTasks.createdAt)).limit(200);
  }

  /* ---------------- 创建 ---------------- */

  async create(callerId: string, raw: unknown): Promise<{ status: 200 | 201; body: Record<string, unknown> }> {
    const b = { ...((raw ?? {}) as Record<string, unknown>) };
    const errors: Array<{ field: string; code: string }> = [];
    const clientRequestId = typeof b["clientRequestId"] === "string" && /^[A-Za-z0-9_\-:.]{1,128}$/.test(b["clientRequestId"]) ? b["clientRequestId"] : null;
    if (!clientRequestId) errors.push({ field: "clientRequestId", code: "required" });
    // CV-D16 批次 6：目标式任务——不传 playbookId（或传 agent_goal）：没有模板与计划条件，参数由授权范围合成，agent 自己的策略决定何时 / 买哪个 / 买多少
    const goalMode = b["playbookId"] === undefined || b["playbookId"] === null || b["playbookId"] === "agent_goal";
    if (goalMode) this.synthesizeGoalTask(b, errors);
    else if (!isPlaybookId(b["playbookId"])) errors.push({ field: "playbookId", code: "unknown_playbook" });
    const brief = this.briefFromBody(b, goalMode, errors);
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
    const { steps, perStepAmountRaw, totalRaw } = playbookBudget(def, params);

    // 授权范围（CV-D16）：缺省由计划推导；给了就必须包住计划（资产 ∋ 计划资产、总额 ≥ 计划总额、每笔 ≥ 计划每笔、步数 ≥ 计划步数、期限 ≥ 计划期限）
    const sr = resolveTaskScope(goalMode ? { trustTier: "agent_data", issuance: "agent", ...(b["scope"] as Record<string, unknown>) } : b["scope"], { objective: def.name.en, inputAssetKey: inEntry.assetKey, outputAssetKeys: [outEntry.assetKey], budgetCapRaw: totalRaw, perStepCapRaw: perStepAmountRaw, maxSteps: steps, deadline: goal.deadline, allowSell: def.side === "sell" }, mode!, nowIso);
    if (!sr.ok) throw new HttpError(400, "invalid_scope", "授权范围校验失败", sr.errors);
    const scope = sr.scope;
    const scopeErrors = this.checkScopeAgainstPlan(scope, { inEntry, outEntry, side: def.side, totalRaw, perStepAmountRaw, steps, planDeadline: goal.deadline, mode: mode! });
    if (scopeErrors.length) throw new HttpError(400, "invalid_scope", "授权范围必须包住计划", scopeErrors);
    const scopeHashValue = computeScopeHash(scope);
    // 硬约束折进条件集（同类型覆盖计划项；硬约束不可被计划放宽）
    const conditionsMerged: ConditionSet = makeConditionSet([...mergeHardConditions(conditions.items.filter((i) => i.type !== "thesis_holds"), scope.hardConditions, REPEATABLE_CONDITION_TYPES), thesisHoldsCondition(thesisId)]);

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
    // v7：带 agent / executor 模式的任务用「毫秒 × 100 + 序号」作 nonce（同一 owner 内唯一，§2.4）；旧客户端照旧（秒）
    const v7Nonce = this.v7 && (b["agent"] !== undefined || b["executor"] !== undefined) ? (BigInt(nowDate.getTime()) * 100n + BigInt(this.nonceSeq++ % 50)).toString() : null;
    const mandateDraft = mode === "LIVE" ? this.buildMandateDraft({ taskId, goal, scope, scopeHash: scopeHashValue, nowSec: Math.floor(nowDate.getTime() / 1000), nonce: typeof b["mandateNonce"] === "string" && /^\d+$/.test(b["mandateNonce"]) ? b["mandateNonce"] : (v7Nonce ?? String(Math.floor(nowDate.getTime() / 1000))) }) : null;

    // 资金组分配（Lane C 未就绪 → stub 全额预留）
    const priority = Number.isInteger(b["priority"]) ? (b["priority"] as number) : 0;
    const budgetGroupId = typeof b["budgetGroupId"] === "string" ? b["budgetGroupId"] : null;
    const allocation = { ...(await this.d.budget.reserve({ owner, taskId, mandateId: null, budgetGroupId, inputAssetKey: inEntry.assetKey, amountRaw: scope.budgetCapRaw, priority, createdAt: nowIso, mandateDeadline: scope.deadline })), priority };

    const timeline: TimelineEntry[] = [{ at: nowIso, type: "created", to: "DRAFT", note: `${def.id} ${mode}${goalMode ? " (goal task: no template, agent's own strategy)" : ""}` }];
    const initial: TaskStatus = mode === "LIVE" ? "AWAITING_AUTHORIZATION" : "ACTIVE";
    timeline.push({ at: nowIso, type: "status", from: "DRAFT", to: initial });
    // v7：agent / executor 模式、准入、recipient == owner、卖出草案（钩子未装配或开关关闭 → null，v6 行为）
    const v7 = this.v7 ? await this.v7.prepareCreate({ callerId, body: b, taskId, owner, recipient, mode: mode!, goalMode, scope, scopeHash: scopeHashValue, goal, nowDate }) : null;
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
        conditionsJson: conditionsMerged,
        conditionsHash: conditionsMerged.hash,
        scopeJson: scope,
        scopeHash: scopeHashValue,
        briefJson: { ...brief, strategy: brief.strategy ? { ...brief.strategy, at: nowIso } : null, strategyHistory: brief.strategy ? [{ ...brief.strategy, at: nowIso }] : [] },
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
        timelineJson: [],
        exitDraftJson: null,
        stepsConfirmed: 0,
        stepsPlanned: steps,
        lastConfirmedStepAt: null,
        deadline: new Date(scope.deadline),
        createdAt: nowDate,
        updatedAt: nowDate,
        ...(v7 ?? {}),
      })
      .onConflictDoNothing()
      .returning();
    if (!row) throw new HttpError(409, "idempotency_conflict");
    await appendTimeline(this.d.db, taskId, timeline, actorOf(callerId));

    // 理由卡（每个任务一张；机器前提 = 条件三态；research 前提来自 body.thesis）
    await this.d.theses.create({ id: thesisId, callerId, owner, taskId, mode: mode!, raw: b["thesis"], conditionsForMachinePremises: conditionsMerged.items.filter((i) => i.type !== "thesis_holds"), defaultGoal: `${def.name.en}: ${def.side} ${outEntry.displaySymbol} in ${steps} step(s)`, defaultValidUntil: goal.deadline });

    // 首次评估（SIMULATION 立即可用；LIVE 也先给出阻塞项全量，K-02）
    const evaluated = await this.evaluateTask(row, { issue: false });
    if (this.v7?.afterCreate) await this.v7.afterCreate(evaluated);
    log.info("任务已创建", { taskId, playbook: def.id, mode, status: evaluated.status, blockers: (evaluated.blockersJson as Blocker[]).map((x) => x.code) });
    return { status: 201, body: await this.view(evaluated) };
  }

  /**
   * 目标式任务：由 scope 合成模板参数（inputAssetKey 缺省 = 登记表第一个资金币种；outputAssetKey = 范围第一个资产；
   * steps = maxSteps（缺省 = 总额 / 每笔，上限 1000）；perStepAmountRaw = 每笔上限；deadline = 范围期限）。params 只允许策略类参数透传。
   */
  private synthesizeGoalTask(b: Record<string, unknown>, errors: Array<{ field: string; code: string }>): void {
    const sc = (b["scope"] && typeof b["scope"] === "object" ? { ...(b["scope"] as Record<string, unknown>) } : {}) as Record<string, unknown>;
    const stables = this.d.registry.entries.filter((e) => e.role === "stable_input");
    const inputAssetKey = typeof sc["inputAssetKey"] === "string" ? sc["inputAssetKey"].toLowerCase() : (stables[0]?.assetKey ?? null);
    const outs = Array.isArray(sc["outputAssetKeys"]) ? (sc["outputAssetKeys"] as unknown[]).filter((k): k is string => typeof k === "string") : [];
    if (!inputAssetKey) errors.push({ field: "scope.inputAssetKey", code: "required_for_goal_task" });
    if (outs.length === 0) errors.push({ field: "scope.outputAssetKeys", code: "required_for_goal_task" });
    if (!isRawAmount(sc["budgetCapRaw"]) || BigInt(String(sc["budgetCapRaw"])) <= 0n) errors.push({ field: "scope.budgetCapRaw", code: "required_for_goal_task" });
    if (!isRawAmount(sc["perStepCapRaw"]) || BigInt(String(sc["perStepCapRaw"])) <= 0n) errors.push({ field: "scope.perStepCapRaw", code: "required_for_goal_task" });
    if (typeof sc["objective"] !== "string" || !sc["objective"].trim()) errors.push({ field: "scope.objective", code: "required_for_goal_task" });
    if (errors.length) return;
    const budget = BigInt(String(sc["budgetCapRaw"]));
    const per = BigInt(String(sc["perStepCapRaw"]));
    const maxSteps = typeof sc["maxSteps"] === "number" ? sc["maxSteps"] : Math.max(1, Math.min(1000, Number(per > 0n ? budget / per : 1n)));
    sc["maxSteps"] = maxSteps;
    sc["inputAssetKey"] = inputAssetKey;
    const p0 = (b["params"] && typeof b["params"] === "object" ? (b["params"] as Record<string, unknown>) : {}) as Record<string, unknown>;
    const passthrough: Record<string, unknown> = {};
    for (const k of ["policyId", "policyVersion", "maxSlippageBps", "maxPriceImpactBps", "maxReferenceDeviationBps"]) if (p0[k] !== undefined) passthrough[k] = p0[k];
    b["playbookId"] = "agent_goal";
    b["params"] = { ...passthrough, inputAssetKey, outputAssetKey: outs[0]!.toLowerCase(), steps: maxSteps, perStepAmountRaw: String(sc["perStepCapRaw"]), ...(typeof sc["deadline"] === "string" ? { deadline: sc["deadline"] } : {}) };
    b["scope"] = sc;
    b["conditions"] = undefined;
  }

  /** 简报（签名之外）：策略文本 / 关注的事件 / 示例来源；issuance=agent 的任务缺省关注一级宏观、财报、联储讲话 */
  private briefFromBody(b: Record<string, unknown>, goalMode: boolean, errors: Array<{ field: string; code: string }>): TaskBrief {
    // 也接受 `brief: { strategy, watch | watchEvents, exampleId }` 这种嵌套写法（服务器验收时这么传过）
    const nested = (b["brief"] && typeof b["brief"] === "object" ? (b["brief"] as Record<string, unknown>) : null);
    if (nested) {
      if (b["strategy"] === undefined && nested["strategy"] !== undefined) b["strategy"] = nested["strategy"];
      if (b["watchEvents"] === undefined && (nested["watchEvents"] ?? nested["watch"]) !== undefined) b["watchEvents"] = nested["watchEvents"] ?? nested["watch"];
      if (b["exampleId"] === undefined && nested["exampleId"] !== undefined) b["exampleId"] = nested["exampleId"];
    }
    let strategy: StrategyVersion | null = null;
    if (b["strategy"] !== undefined && b["strategy"] !== null) {
      if (typeof b["strategy"] !== "string" || b["strategy"].length > STRATEGY_MAX_CHARS) errors.push({ field: "strategy", code: `expected_string_max_${STRATEGY_MAX_CHARS}` });
      else if (b["strategy"].trim()) strategy = { version: 1, text: b["strategy"].trim(), by: "owner", at: "" };
    }
    let kinds: string[] | null = null;
    const w = b["watchEvents"];
    if (w !== undefined && w !== null) {
      const ks = (w && typeof w === "object" ? (w as { kinds?: unknown }).kinds : undefined);
      if (!Array.isArray(ks) || !ks.every((k) => typeof k === "string" && (EVENT_KINDS as readonly string[]).includes(k))) errors.push({ field: "watchEvents.kinds", code: `expected_subset_of_${EVENT_KINDS.join("|")}` });
      else kinds = [...new Set(ks as string[])];
    }
    const sc = (b["scope"] && typeof b["scope"] === "object" ? (b["scope"] as Record<string, unknown>) : {}) as Record<string, unknown>;
    const agentIssued = goalMode || sc["issuance"] === "agent";
    const exampleId = typeof b["exampleId"] === "string" && b["exampleId"].length <= 64 ? b["exampleId"] : null;
    return { strategy, strategyHistory: [], currentPlan: null, watch: { kinds: kinds ?? (agentIssued ? [...DEFAULT_WATCH_KINDS] : []) }, agent: null, exampleId };
  }

  /** 范围必须包住计划（计划只能在范围之内动） */
  private checkScopeAgainstPlan(scope: TaskScope, p: { inEntry: NonNullable<ReturnType<typeof findEntry>>; outEntry: NonNullable<ReturnType<typeof findEntry>>; side: "buy" | "sell"; totalRaw: string; perStepAmountRaw: string; steps: number; planDeadline: string; mode: "LIVE" | "SIMULATION" }): Array<{ field: string; code: string }> {
    const errors: Array<{ field: string; code: string }> = [];
    if (scope.inputAssetKey !== p.inEntry.assetKey.toLowerCase()) errors.push({ field: "scope.inputAssetKey", code: "must_match_params.inputAssetKey" });
    if (!scope.outputAssetKeys.includes(p.outEntry.assetKey.toLowerCase())) errors.push({ field: "scope.outputAssetKeys", code: "must_include_params.outputAssetKey" });
    for (const k of scope.outputAssetKeys) {
      const e = findEntry(this.d.registry, k);
      if (!e || e.role !== "stock_output") errors.push({ field: "scope.outputAssetKeys", code: `not_stock_output:${k}` });
      else if (p.mode === "LIVE" && !e.executionAllowed) errors.push({ field: "scope.outputAssetKeys", code: `execution_not_allowed:${k}` });
    }
    if (BigInt(scope.budgetCapRaw) < BigInt(p.totalRaw)) errors.push({ field: "scope.budgetCapRaw", code: "must_be_gte_plan_total" });
    if (BigInt(scope.perStepCapRaw) < BigInt(p.perStepAmountRaw)) errors.push({ field: "scope.perStepCapRaw", code: "must_be_gte_plan_per_step" });
    if (scope.maxSteps < p.steps) errors.push({ field: "scope.maxSteps", code: "must_be_gte_plan_steps" });
    if (Date.parse(scope.deadline) < Date.parse(p.planDeadline)) errors.push({ field: "scope.deadline", code: "must_be_gte_plan_deadline" });
    if (p.side === "sell" && !scope.allowSell) errors.push({ field: "scope.allowSell", code: "sell_playbook_requires_allowSell" });
    return errors;
  }

  /**
   * 授权草案 = 范围（CV-D16）：budgetCap / perStepCap / maxSteps / deadline / outputSet 全部来自 scope，
   * effectivePolicyHash 折入 scopeHash（展开参数名沿用 conditionsHash）。计划（legs）只是 auto 签发时的默认路线，不进签名。
   */
  private buildMandateDraft(a: { taskId: string; goal: PlanGoal; scope: TaskScope; scopeHash: Bytes32; nowSec: number; nonce: string }): MandateDraft {
    const planGuard = this.d.cfg.PLANGUARD_ADDRESS;
    if (!planGuard) throw new HttpError(503, "planguard_not_configured", "LIVE 任务需要 PLANGUARD_ADDRESS；可先用 mode=SIMULATION");
    const def = findPolicy(a.goal.policyId, a.goal.policyVersion);
    if (!def) throw new HttpError(400, "unknown_policy");
    const resolved = resolveParams(def, { maxSlippageBps: a.goal.maxSlippageBps, maxPriceImpactBps: a.goal.maxPriceImpactBps, maxReferenceDeviationBps: a.goal.policyId === "QUOTE_ONLY" ? null : (a.goal.maxReferenceDeviationBps ?? null) });
    if (!resolved.ok) throw new HttpError(400, "policy_param_out_of_range", "策略参数越界", resolved.errors);
    const policy = policyWithConditions(def, resolved.params, a.scopeHash);
    const sell = a.goal.side === "sell";
    const stableKey = sell ? a.goal.legs[0]!.outputAssetKey : a.goal.budget.inputAssetKeys[0]!;
    const stockKey = sell ? a.goal.budget.inputAssetKeys[0]! : a.goal.legs[0]!.outputAssetKey;
    const stable = findEntry(this.d.registry, stableKey)!;
    const stock = findEntry(this.d.registry, stockKey)!;
    // 买入：输出集 = 范围内全部允许的股票代币；卖出：输出集 = [资金币种]
    const outputSet: EvmAddress[] = sell ? [stable.tokenAddress] : a.scope.outputAssetKeys.map((k) => findEntry(this.d.registry, k)!.tokenAddress);
    const mandate: TradeMandate = {
      owner: a.goal.ownerAddress,
      recipient: a.goal.recipientAddress,
      inputToken: sell ? stock.tokenAddress : stable.tokenAddress,
      outputSetHash: outputSetHash(outputSet),
      budgetCap: a.scope.budgetCapRaw,
      perStepCap: a.scope.perStepCapRaw,
      maxSteps: String(a.scope.maxSteps),
      policyDefinitionHash: policy.policyDefinitionHash,
      effectivePolicyHash: policy.effectivePolicyHash,
      registryHash: registryHash(this.d.registry),
      validFrom: String(a.nowSec - 60),
      deadline: String(Math.floor(Date.parse(a.scope.deadline) / 1000)),
      nonce: a.nonce,
    };
    const domain = makePlanGuardDomain(this.d.cfg.EXECUTION_CHAIN_ID, planGuard as EvmAddress);
    const registerBody = { clientRequestId: `${a.taskId}:auth`, inputAssetKey: stable.assetKey, legs: [{ outputAssetKey: stock.assetKey, weightBps: 10_000 }], outputAssetKeys: sell ? undefined : a.scope.outputAssetKeys, side: a.goal.side, policyId: a.goal.policyId, policyVersion: a.goal.policyVersion, maxSlippageBps: resolved.params.maxSlippageBps, maxPriceImpactBps: resolved.params.maxPriceImpactBps, maxReferenceDeviationBps: resolved.params.maxReferenceDeviationBps, conditionsHash: a.scopeHash, sku: "task_bundle" };
    return { mandate, domain, typedData: { domain, types: EIP712_TYPES_V2, primaryType: "TradeMandate", message: mandate }, outputSet, conditionsHash: a.scopeHash, scopeHash: a.scopeHash, effectivePolicyHash: policy.effectivePolicyHash, policyDefinitionHash: policy.policyDefinitionHash, registerBody, note: "Sign typedData with the owner wallet and POST it to /v1/tasks/:id/authorize as { signature }. effectivePolicyHash binds scopeHash (objective, allowed assets, budget, per-step cap, steps, deadline, allowSell, trust tier, issuance, hard constraints): plan conditions can change without a new signature; the scope cannot change at all (CV-D16)." };
  }

  /* ---------------- 视图 ---------------- */

  taskOf(row: TaskRow, presence: Task["executorPresence"]): Task {
    return {
      id: row.id,
      owner: row.ownerAddress as EvmAddress,
      playbookId: row.playbookId as Task["playbookId"],
      goal: row.goalJson as PlanGoal,
      conditions: row.conditionsJson as ConditionSet,
      ...(row.scopeJson ? { scope: row.scopeJson as TaskScope, scopeHash: row.scopeHash as Bytes32 } : {}),
      ...(row.briefJson ? { brief: row.briefJson as TaskBrief } : {}),
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
        current: m.conditionsHash === bindingHashOf(row),
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
      /** CV-D16：签名绑定的哈希与边界说明 */
      bindingHash: bindingHashOf(row),
      scopeBoundary: SCOPE_BOUNDARY_NOTE,
      /** CV-D16 批次 3：当前轮次（issuance=agent 的任务） */
      agentTurn: (row.agentTurnJson as AgentTurn | null) ?? null,
      evidenceMode: row.mode === "SIMULATION" ? "SIMULATION" : this.d.evidence.mode,
      ...(this.v7 ? await this.v7.view(row) : {}),
    };
  }

  /* ---------------- 状态转移 ---------------- */

  /** @internal 意图服务共用 */
  async setStatus(row: TaskRow, to: TaskStatus, note: string, extra: Partial<typeof verifyTasks.$inferInsert> = {}, actor: Actor = "system"): Promise<TaskRow> {
    const from = row.status as TaskStatus;
    if (from !== to && !canTransition(from, to)) throw new HttpError(409, "invalid_transition", `${from} → ${to} 不允许`);
    const now = this.now();
    let [updated] = await this.d.db.update(verifyTasks).set({ status: to, updatedAt: now, ...extra }).where(and(eq(verifyTasks.id, row.id), eq(verifyTasks.status, from))).returning();
    if (!updated) throw new HttpError(409, "concurrent_update");
    if (from !== to) {
      const tl = await appendTimeline(this.d.db, row.id, { at: now.toISOString(), type: "status", from, to, note }, actor);
      updated = tl.row ?? updated;
      await this.d.notifier.emit(notificationPayload("task.status_changed", row.id, tl.ids[0] ?? 0, `${from} → ${to}: ${note}`, `/agent/tasks/${row.id}`, now.toISOString()), row.ownerAddress);
    }
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
      const paused = await this.setStatus(row, "PAUSED", "paused by owner (service-side: stops issuance only)", { pausedBy: "owner" }, actorOf(callerId));
      const hostedNote = this.v7 ? await this.v7.onPause(paused) : null;
      return { row: paused, note: hostedNote ? `${hostedNote} ${STOP_SEMANTICS_NOTE}` : STOP_SEMANTICS_NOTE };
    }
    if (action === "resume") {
      if (from !== "PAUSED") throw new HttpError(409, "invalid_transition", `${from} 不能恢复`);
      for (const mid of row.mandateIds) {
        const m = await this.d.mandates.byId(mid);
        // 修复（X-24）：scope 任务的授权存的是 scopeHash，必须与绑定哈希比较（此前比 conditionsHash，scope 任务暂停后授权永远停在 PAUSED）
        if (m?.state === "PAUSED" && m.conditionsHash === bindingHashOf(row)) await this.d.mandates.transition(callerId, mid, "ACTIVE", { viaTask: true });
      }
      const resumed = await this.setStatus(row, "ACTIVE", "resumed by owner; re-evaluating", { pausedBy: null }, actorOf(callerId));
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
    return { row: await this.setStatus(row, to, hadMandate ? "cancelled service-side; waiting for on-chain revokeMandate confirmation" : "cancelled", {}, actorOf(callerId)), note: STOP_SEMANTICS_NOTE };
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
    const b = (raw ?? {}) as Record<string, unknown>;
    // v7：itemId（缺省 buy；sell:<assetKey> = 委托清单里的卖出授权）
    const itemId = typeof b["itemId"] === "string" ? b["itemId"] : "buy";
    const delegation = isDelegationTask(row) && !!this.v7;
    if (itemId !== "buy") {
      if (!delegation || !itemId.startsWith("sell:")) throw new HttpError(422, "unknown_item", "itemId 只能是 buy 或委托清单里的 sell:<assetKey>");
      return this.v7!.authorizeSell(callerId, row, itemId, b);
    }
    const draft = row.mandateDraftJson as MandateDraft | null;
    if (!draft) throw new HttpError(409, "no_mandate_draft");
    // F/SDK 形态：{ typedData, signature, outputSet, clientRequestId }；也接受 { mandate, signature }
    const fromTyped = b["typedData"] && typeof b["typedData"] === "object" ? ((b["typedData"] as { message?: unknown }).message ?? null) : null;
    const mandate = (b["mandate"] && typeof b["mandate"] === "object" ? b["mandate"] : (fromTyped ?? draft.mandate)) as TradeMandate;
    // v7 委托任务：每项固定 clientRequestId（重试幂等，不再因 mandateIds 长度变化而 409）
    const body = { ...draft.registerBody, clientRequestId: typeof b["clientRequestId"] === "string" ? b["clientRequestId"] : delegation ? `${row.id}:auth:buy` : `${row.id}:auth:${row.mandateIds.length}`, mandate, signature: b["signature"], conditionsHash: bindingHashOf(row) };
    if (mandate.effectivePolicyHash?.toLowerCase() !== draft.effectivePolicyHash.toLowerCase()) throw new HttpError(422, "mandate_rejected", "mandate.effectivePolicyHash 与任务授权范围（scopeHash）不一致：范围不可改，放宽范围请建新任务（CV-D16）", [{ field: "mandate.effectivePolicyHash", code: "scope_hash_mismatch" }]);
    const r = await this.d.mandates.register(callerId, body, { taskId: row.id, ...(delegation ? { delegationItemId: "buy" } : {}), ...(this.v7 ? { fromBlock: await this.v7.fromBlock() } : {}) });
    const order = await this.d.orders.byRef(r.row.id);
    if (order && (order.priceUsd === "0" || this.d.orders.isDeliverable(order))) {
      await this.d.mandates.activate(r.row.id);
      if (order.state !== "DELIVERED") await this.d.orders.markDelivered(order.id);
    }
    const mrow = (await this.d.mandates.byId(r.row.id))!;
    const allocation = await this.d.budget.reserve({ owner: row.ownerAddress as EvmAddress, taskId: row.id, mandateId: mrow.id, budgetGroupId: row.budgetGroupId, inputAssetKey: scopeOf(row)?.inputAssetKey ?? (row.goalJson as PlanGoal).budget.inputAssetKeys[0]!, amountRaw: mrow.budgetCap, priority: (row.budgetAllocationJson as { priority?: number } | null)?.priority ?? 0, createdAt: this.now().toISOString(), mandateDeadline: mrow.deadline.toISOString(), mandateValidFrom: mrow.validFrom.toISOString() });
    const ids = row.mandateIds.includes(mrow.id) ? row.mandateIds : [...row.mandateIds, mrow.id];
    let updated = (await this.d.db.update(verifyTasks).set({ mandateIds: ids, budgetAllocationJson: allocation, updatedAt: this.now() }).where(eq(verifyTasks.id, row.id)).returning())[0]!;
    updated = (await appendTimeline(this.d.db, row.id, { at: this.now().toISOString(), type: "authorized", ref: mrow.id, note: `mandate ${mrow.id} ${mrow.state}` }, actorOf(callerId))).row ?? updated;
    // v7 委托任务：买入授权 ACTIVE 不够，要等 buyReady（资金币种 permit confirmed / not_needed）才转 ACTIVE
    if (delegation) updated = (await this.v7!.refreshDelegation(row.id)) ?? updated;
    else if (updated.status === "AWAITING_AUTHORIZATION" && mrow.state === "ACTIVE") updated = await this.setStatus(updated, "ACTIVE", `authorized: mandate ${mrow.id}`, {}, actorOf(callerId));
    updated = await this.evaluateTask(updated, { issue: false });
    return { row: updated, mandate: await this.d.mandates.view(mrow) };
  }

  /**
   * 改计划条件（CV-D16 改写 K-09）：计划条件在签名之外，改了不需要新授权，现有授权继续有效；
   * 硬约束（scope.hardConditions）同类型不可被计划条件触碰 → 409 scope_locked（要放宽范围 = 建新任务）。
   * 旧任务（无 scope）沿用 K-09：改条件 = 新授权（旧授权服务侧暂停签发但不撤销）。
   */
  async updateConditions(callerId: string, id: string, raw: unknown): Promise<TaskRow> {
    const row = await this.requireTask(callerId, id);
    return this.applyConditions(row, raw, callerId);
  }

  /** 计划条件写入（鉴权由调用方完成；agent-status 的 plan_revised 走这里，授权的服务侧暂停用任务自己的 callerId） */
  private async applyConditions(row: TaskRow, raw: unknown, callerId: string): Promise<TaskRow> {
    if (TASK_TERMINAL_STATUSES.has(row.status as TaskStatus) || row.status === "REVOKE_PENDING") throw new HttpError(409, "invalid_transition", `${row.status} 不能改条件`);
    const def = playbookOf(this.d.playbooks, row.playbookId as PlaybookDefinition["id"]);
    const items = raw && typeof raw === "object" && Array.isArray((raw as { items?: unknown }).items) ? ((raw as { items: unknown[] }).items) : null;
    if (!items) throw new HttpError(400, "invalid_request", "需要 { items: Condition[] }");
    const mc = mergeConditions(def, row.paramsJson as Record<string, unknown>, items, row.mode as "LIVE" | "SIMULATION");
    if (!mc.ok) throw new HttpError(400, "invalid_conditions", "条件校验失败", mc.errors);
    const scope = scopeOf(row);
    const nowDate = this.now();
    if (scope) {
      const touched = touchesHardConditions(mc.set.items, scope.hardConditions, REPEATABLE_CONDITION_TYPES);
      if (touched.length > 0) throw new HttpError(409, "scope_locked", `硬约束 ${touched.join(", ")} 在授权范围里，不能用计划条件覆盖；放宽范围请建新任务`, touched.map((t) => ({ field: "items", code: `hard_condition_locked:${t}` })));
      const conditions = makeConditionSet([...mergeHardConditions(mc.set.items.filter((i) => i.type !== "thesis_holds"), scope.hardConditions, REPEATABLE_CONDITION_TYPES), thesisHoldsCondition(row.thesisId!)]);
      if (conditions.hash === row.conditionsHash) return row;
      const [updated0] = await this.d.db.update(verifyTasks).set({ conditionsJson: conditions, conditionsHash: conditions.hash, updatedAt: nowDate }).where(eq(verifyTasks.id, row.id)).returning();
      const updated = (await appendTimeline(this.d.db, row.id, { at: nowDate.toISOString(), type: "conditions_changed", note: `${row.conditionsHash} → ${conditions.hash}; authorization unchanged (plan conditions are outside the signed scope, CV-D16)` }, actorOf(callerId))).row ?? updated0;
      return this.evaluateTask(updated!, { issue: false });
    }
    // 旧任务：K-09
    const conditions = makeConditionSet([...mc.set.items.filter((i) => i.type !== "thesis_holds"), thesisHoldsCondition(row.thesisId!)]);
    if (conditions.hash === row.conditionsHash) return row;
    for (const mid of row.mandateIds) {
      const m = await this.d.mandates.byId(mid);
      if (m?.state === "ACTIVE") await this.d.mandates.transition(callerId, mid, "PAUSED");
    }
    const [updated0] = await this.d.db.update(verifyTasks).set({ conditionsJson: conditions, conditionsHash: conditions.hash, mandateDraftJson: null, updatedAt: nowDate }).where(eq(verifyTasks.id, row.id)).returning();
    const updated = (await appendTimeline(this.d.db, row.id, { at: nowDate.toISOString(), type: "conditions_changed", note: `${row.conditionsHash} → ${conditions.hash}; previous mandates paused server-side (certificates already pulled may still execute until expiry; revoke on-chain to stop completely)` }, actorOf(callerId))).row ?? updated0;
    const moved = row.mode === "LIVE" && row.status !== "AWAITING_AUTHORIZATION" ? await this.setStatus(updated!, "AWAITING_AUTHORIZATION", "conditions changed: new authorization required (legacy task without scope)", {}, actorOf(callerId)) : updated!;
    return this.evaluateTask(moved, { issue: false });
  }

  /* ---------------- 评估（monitor 与 prepare-step 共用） ---------------- */

  private stockAndStable(goal: PlanGoal): { stockKey: string; stableKey: string } {
    const sell = goal.side === "sell";
    return { stockKey: sell ? goal.budget.inputAssetKeys[0]! : goal.legs[0]!.outputAssetKey, stableKey: sell ? goal.legs[0]!.outputAssetKey : goal.budget.inputAssetKeys[0]! };
  }

  /** @internal 意图服务共用 */
  async taskState(row: TaskRow): Promise<TaskConditionState> {
    const goal = row.goalJson as PlanGoal;
    const { stockKey } = this.stockAndStable(goal);
    const stock = findEntry(this.d.registry, stockKey);
    // 范围内全部资产的标的都要看（事件 / 财报覆盖）；计划资产排第一
    const scopeKeys = scopeOf(row)?.outputAssetKeys ?? [];
    const underlyingIds = [...new Set([...(stock ? [stock.underlyingId] : []), ...scopeKeys.map((k) => findEntry(this.d.registry, k)?.underlyingId).filter((u): u is string => !!u)])];
    const nowMs = this.now().getTime();
    const today = nyDateAt(nowMs);
    let stepsToday = 0;
    for (const mid of row.mandateIds) for (const s of await this.d.mandates.steps(mid)) if (s.state === "CONFIRMED" && nyDateAt(s.updatedAt.getTime()) === today) stepsToday++;
    const groupToday = row.budgetGroupId ? await this.d.budget.stepsConfirmedToday(row.budgetGroupId, today) : null;
    const def = playbookOf(this.d.playbooks, row.playbookId as PlaybookDefinition["id"]);
    const { perStepAmountRaw } = playbookBudget(def, row.paramsJson as Record<string, unknown>);
    return { underlyingIds, outputAssetKeys: [stockKey, ...scopeKeys.filter((k) => k !== stockKey)], mode: row.mode as "LIVE" | "SIMULATION", lastConfirmedStepAt: row.lastConfirmedStepAt?.toISOString() ?? null, stepsConfirmedToday: stepsToday, stepsConfirmedTodayInBudgetGroup: groupToday, nextStepAmountRaw: perStepAmountRaw };
  }

  /** 组装条件证据：上下文 + 事件 + 余额（资金组）+ 理由卡 */
  /** @internal 意图服务共用 */
  async conditionEvidence(row: TaskRow, st: TaskConditionState, thesis: { id: string; status: string; evidenceIds: string[] } | null): Promise<{ evidence: ConditionEvidence; records: EvidenceRecord[] }> {
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

  /** @internal 意图服务共用 */
  quoteFromReport(report: VerifyReport): NonNullable<ConditionEvidence["quote"]> {
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
    const policy = policyWithConditions(pdef, resolved.params, bindingHashOf(row));
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
      // 下次复评 = 下一个 monitor tick（常规时段 / 休市周期不同）；THESIS_INVALIDATED / THESIS_UNKNOWN 的 nextCheckAt 据此不为 null（V-27）
      const tick = sessionLabelAtMs(nowDate.getTime()) === "US_REGULAR" ? this.d.cfg.MONITOR_INTERVAL_REGULAR_MS : this.d.cfg.MONITOR_INTERVAL_CLOSED_MS;
      evidence.theses = { [updatedThesis.id]: { status: updatedThesis.status as ConditionEvidence["theses"][string]["status"], evidenceIds: result.evidenceIds, nextCheckAt: new Date(nowDate.getTime() + tick).toISOString() } };
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
    // CV-D16 批次 3 / 6：issuance=agent 的任务——观察变化就开轮次叫 agent：条件清空 = 可以提交意图；有阻塞 = 告诉它在等什么；
    // 关注的事件临近 / 到点 / 修订 = 事件驱动的轮次（到点只是「预定时间已到，去核实实际值」，不是「已根据结果判断」）
    let turn: AgentTurn | null = null;
    if (scopeOf(cur)?.issuance === "agent" && cur.status !== "AWAITING_AUTHORIZATION" && cur.status !== "PAUSED" && !completed) {
      const blockersPart = blockers.length === 0 ? "clear" : key;
      const ev = this.eventObservation(cur, base.evidence.events.map((x) => x.event), nowDate);
      const prev = (cur.agentTurnJson as AgentTurn | null) ?? null;
      const prevBlockersPart = prev?.observationKey.split("|")[0] ?? null;
      const eventOnly = !!prev && prevBlockersPart === blockersPart && ev.key !== (prev.eventsKey ?? "") && ev.changed.length > 0;
      const base_ = blockers.length === 0 ? "conditions are clear inside your scope: submit a trade intent, decline, ask for evidence, revise the plan or end the task" : `waiting on: ${[...new Set(blockers.map((b) => b.code))].join(", ")}`;
      const observationKey = `${blockersPart}${ev.key ? `|${ev.key}` : ""}`;
      turn = await this.nextAgentTurn(cur, observationKey, eventOnly ? "event" : blockers.length === 0 ? "ready_for_intent" : "observation_changed", eventOnly ? `event update: ${ev.changed.join("; ")} — ${base_}` : `${base_}${ev.changed.length ? ` · events: ${ev.changed.join("; ")}` : ""}`, nowDate, ev.key);
    }
    const extra = { blockersJson: [...blockers, ...info], nextCheckAt, lastEvaluationJson: last, ...(turn ? { agentTurnJson: turn } : {}) };
    if (status !== cur.status) return this.setStatus(cur, status, `evaluated: ${finalEval.outcome}${mandateInfo ? ` / mandate ${mandateInfo.status}` : ""}`, extra);
    // 「更新于」只在有实质变化时刷新：阻塞项变了或排了新的 Agent 轮次。定时重评估什么都没变时不动它（10/5 走查：所有任务的更新时间都一样）
    const blockerKey = (list: ReadonlyArray<{ code: string }>) => list.map((x) => x.code).sort().join(",");
    const changed = Boolean(turn) || blockerKey(extra.blockersJson) !== blockerKey((cur.blockersJson as Array<{ code: string }> | null) ?? []);
    const [updated] = await this.d.db.update(verifyTasks).set({ ...extra, ...(changed ? { updatedAt: nowDate } : {}) }).where(eq(verifyTasks.id, cur.id)).returning();
    return updated ?? cur;
  }

  /** E-06：财报后双原因闸门（Lane D postEarningsGate）——只对「已发生且窗口刚结束」的相关财报事件生效 */
  /** @internal 意图服务共用 */
  postEarnings(conditions: ConditionSet, evidence: ConditionEvidence, report: VerifyReport, nowIso: string): { blockers: Blocker[]; reasons: Reason[]; nextCheckAt: string | null } {
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

  /** 当前绑定哈希对应的可用授权（scopeHash / 旧任务 conditionsHash 一致且 ACTIVE/PAUSED） */
  /** @internal 意图服务共用 */
  async currentMandate(row: TaskRow): Promise<MandateRow | null> {
    for (const id of [...row.mandateIds].reverse()) {
      const m = await this.d.mandates.byId(id);
      // v7：委托清单里的卖出授权与买入授权同绑定哈希，但不是「当前授权」（只按意图签发）
      if (m && m.conditionsHash === bindingHashOf(row) && (m.state === "ACTIVE" || m.state === "PAUSED") && !MandatesService.isDelegationSell(m)) return m;
    }
    return null;
  }

  /* ---------------- 唤醒通路（CV-D16 批次 3） ---------------- */

  /**
   * 观察键变了才开新轮次；上一轮 awaiting 且过了 respondBy → 记 no_response（信息项，不动任务）。
   * 返回要写回的 AgentTurn（null = 不变）。通知 `task.agent_turn` 幂等键 = taskId:version。
   */
  /**
   * 事件观察（批次 6）：关注种类的事件在 [-6h, +48h] 内，键 = `${id}@${revision}:${upcoming|released}`；
   * released 只表示预定时间已过——实际值平台不一定有，agent 要自己去核实。
   */
  private eventObservation(row: TaskRow, events: readonly MarketEvent[], nowDate: Date): { key: string; changed: string[] } {
    const kinds = new Set(((row.briefJson as TaskBrief | null)?.watch.kinds ?? []) as string[]);
    if (kinds.size === 0) return { key: "", changed: [] };
    const nowMs = nowDate.getTime();
    // v7（CV-D22，Lane D 契约）：观察键 = `${id}@${revision}:${dataStatus}`——到点无值（due_pending_data）、实际值入库（data_arrived）、官方修订（revised）各是一次变化
    const items = events
      .filter((e) => kinds.has(e.kind) && e.status !== "cancelled")
      .map((e) => ({ e, at: eventDueAtMs(e) }))
      .filter(({ at }) => at >= nowMs - EVENT_WATCH_PAST_MS && at <= nowMs + EVENT_WATCH_AHEAD_MS);
    const statusText = (s: string) => (s === "upcoming" ? "upcoming" : s === "due_pending_data" ? "scheduled time passed — verify the actual value yourself (not in yet; do not treat it as happened)" : s === "data_arrived" ? "actual value arrived" : "actual value revised");
    const parts = items.map(({ e }) => { const key = eventObservationKey(e, nowMs); const st = key.slice(key.lastIndexOf(":") + 1); return { part: key, text: `${e.name} (${e.kind}) ${statusText(st)} ${e.scheduledAtUtc ?? e.dateLocal}${e.revision > 1 ? ` rev ${e.revision}` : ""}` }; }).sort((a, b) => (a.part < b.part ? -1 : 1));
    const prev = new Set(((row.agentTurnJson as AgentTurn | null)?.eventsKey ?? "").split(",").filter(Boolean));
    return { key: parts.map((p) => p.part).join(","), changed: parts.filter((p) => !prev.has(p.part)).map((p) => p.text) };
  }

  private async nextAgentTurn(row: TaskRow, observationKey: string, reason: AgentTurnReason, summary: string, nowDate: Date, eventsKey = ""): Promise<AgentTurn | null> {
    const cur = (row.agentTurnJson as AgentTurn | null) ?? null;
    const nowIso = nowDate.toISOString();
    if (cur && cur.observationKey === observationKey) {
      if (cur.state === "awaiting_agent" && Date.parse(cur.respondBy) <= nowDate.getTime()) {
        const expired: AgentTurn = { ...cur, state: "no_response", respondedAt: null };
        await this.d.db.update(verifyTasks).set({ agentTurnJson: expired }).where(eq(verifyTasks.id, row.id));
        await appendTimeline(this.d.db, row.id, { at: nowIso, type: "agent_no_response", note: `turn ${cur.version} (${cur.reason}) got no response by ${cur.respondBy}; nothing was done`, data: { turnVersion: cur.version } }, "system");
        return expired;
      }
      return null;
    }
    const turn: AgentTurn = { version: (cur?.version ?? 0) + 1, reason, observationKey, summary, requestedAt: nowIso, respondBy: new Date(nowDate.getTime() + AGENT_TURN_RESPOND_MS).toISOString(), state: "awaiting_agent", respondedAt: null, intentId: null, response: null, eventsKey };
    await appendTimeline(this.d.db, row.id, { at: nowIso, type: "agent_turn", note: `turn ${turn.version} (${reason}): ${summary}`, data: { turnVersion: turn.version, reason } }, "system");
    await this.d.notifier.emit(notificationPayload("task.agent_turn", row.id, turn.version, `your turn (${reason}): ${summary}`.slice(0, 500), `/agent/tasks/${row.id}`, nowIso), row.ownerAddress);
    return turn;
  }

  /**
   * 意图提交后由 IntentsService 调：当前轮次 → intent_received。
   * v7（CV-D25）：带 turnVersion 时只关闭同版本的轮次（期间开出的更新轮次保持打开）；托管 Agent 的认证 / 模拟意图记为该轮的终结动作，
   * 被拒的意图不关闭轮次（同轮可改一次）；nextCheckAt 写进 verify_tasks.next_agent_check_at。
   */
  async markTurnIntent(row: TaskRow, intentId: string, nowIso: string, v7: { turnVersion?: number; status?: string; clientRequestId?: string; nextCheckAt?: string; hosted?: boolean } = {}): Promise<AgentTurn | null> {
    const fresh = (await this.byId(row.id)) ?? row;
    const cur = (fresh.agentTurnJson as AgentTurn | null) ?? null;
    const nowDate = new Date(nowIso);
    if (v7.hosted && v7.turnVersion !== undefined && v7.status && isTerminalIntentStatus(v7.status)) await recordHostedTurnAction(this.d.db, row.id, v7.turnVersion, { kind: "intent", ref: intentId, status: v7.status, clientRequestId: v7.clientRequestId ?? null }, nowDate);
    const brief = (fresh.briefJson as TaskBrief | null) ?? null;
    const set: Partial<typeof verifyTasks.$inferInsert> = { ...(brief?.agent ? { briefJson: { ...brief, agent: { ...brief.agent, lastResponseAt: nowIso } } } : {}), ...(v7.nextCheckAt ? { nextAgentCheckAt: new Date(v7.nextCheckAt) } : {}) };
    const sameTurn = !!cur && (v7.turnVersion === undefined || cur.version === v7.turnVersion);
    const closes = !!cur && cur.state !== "ended" && sameTurn && !(v7.hosted && v7.status === "rejected");
    const turn: AgentTurn | null = closes ? { ...cur!, state: "intent_received", respondedAt: nowIso, intentId } : cur;
    if (closes) set.agentTurnJson = turn;
    if (Object.keys(set).length) await this.d.db.update(verifyTasks).set(set).where(eq(verifyTasks.id, row.id));
    return turn;
  }

  /**
   * v7（CV-D25）：接受交易意图 / 状态报告之前的轮次绑定检查。
   *  - 解析 turnVersion / clientRequestId / nextCheckAt（∈ [now+60 s, scope.deadline]）/ invalidation；
   *  - 托管 Agent：turnVersion 缺省 = 令牌绑定的轮次，给了必须相等（409 turn_version_mismatch）；每轮只接受一个终结动作
   *    （409 turn_already_answered 并带回已记录动作；同 clientRequestId 视为重放）；被拒意图同轮最多再改一次（409 intent_revision_limit）；
   *  - 自带 Agent：状态报告按 clientRequestId 去重（最近 20 个）。
   */
  async beginAgentAction(callerId: string, row: TaskRow, raw: unknown, kind: "intent" | "status"): Promise<{ binding: TurnBinding; hosted: boolean; replay: RecordedTurnAction | null }> {
    const scope = scopeOf(row);
    const tb = resolveTurnBinding(raw, { nowMs: this.now().getTime(), deadline: scope?.deadline ?? null });
    if (!tb.ok) throw new HttpError(400, "invalid_request", "轮次绑定字段校验失败", tb.errors);
    const binding = { ...tb.binding };
    if (callerId !== "agent:hosted") {
      const cur = (row.agentTurnJson as AgentTurn | null) ?? null;
      const seen = kind === "status" && !!binding.clientRequestId && (cur?.answeredRequestIds ?? []).includes(binding.clientRequestId);
      return { binding, hosted: false, replay: seen ? { kind: "status", ref: `turn:${cur!.version}`, status: cur!.state, clientRequestId: binding.clientRequestId! } : null };
    }
    const run = currentRunBinding();
    if (!run || run.taskId !== row.id) throw new HttpError(403, "run_token_required", "hosted agent actions need the run token bound to this task");
    if (binding.turnVersion === undefined) binding.turnVersion = run.turnVersion;
    else if (binding.turnVersion !== run.turnVersion) throw new HttpError(409, "turn_version_mismatch", `this run answers turn ${run.turnVersion}`, { runTurnVersion: run.turnVersion });
    if (!binding.clientRequestId) throw new HttpError(400, "invalid_request", "hosted agent actions need clientRequestId (h:<runId>:<seq>)", [{ field: "clientRequestId", code: "required_for_hosted_agent" }]);
    const state = await hostedTurnState(this.d.db, row.id, binding.turnVersion);
    const decision = decideTurnAction(state, { kind, clientRequestId: binding.clientRequestId });
    if (decision.kind === "conflict") throw new HttpError(409, decision.code, decision.code === "turn_already_answered" ? `turn ${binding.turnVersion} already has a terminal action` : `turn ${binding.turnVersion} already had ${state.rejectedIntents} rejected intents; report a status instead`, { recordedAction: decision.recorded, turnVersion: binding.turnVersion });
    return { binding, hosted: true, replay: decision.kind === "replay" ? decision.recorded : null };
  }

  /**
   * v7（§2.6）：Agent 报 ended 的唯一含义——内部路径把任务转 PAUSED（paused_by = agent），不调用需要 owner 身份的 transition；
   * 授权的服务侧暂停用任务自己的 callerId；不再开新轮次；presence = ended；needsOwner: agent_ended（恢复 / 取消由 owner 决定）。
   */
  async pauseByAgent(row: TaskRow, note: string, actor: Actor = "agent:hosted"): Promise<TaskRow> {
    const cur = (await this.byId(row.id)) ?? row;
    if (!TASK_RUNNING_STATUSES.has(cur.status as TaskStatus)) return cur;
    for (const mid of cur.mandateIds) {
      const m = await this.d.mandates.byId(mid);
      if (m?.state === "ACTIVE") await this.d.mandates.transition(cur.callerId, mid, "PAUSED");
    }
    return this.setStatus(cur, "PAUSED", `paused on the agent's ended report (service-side only): ${note}`.slice(0, 300), { pausedBy: "agent", nextAgentCheckAt: null }, actor);
  }

  /**
   * v7（§2.6 轮次调度）：开一个特殊原因的轮次（assigned / authorized / scheduled / data_arrived / execution_failed）。
   * observationKey 保持评估口径（下一次 monitor 评估不会因为键不同又开一轮）；triggerKey 去重（同键不重复开）。
   * 任务不在运行态、或已因 Agent 报 ended 暂停 → 不开（返回 null）。
   */
  async openAgentTurn(taskId: string, reason: AgentTurnReason, summary: string, triggerKey: string): Promise<AgentTurn | null> {
    const row = await this.byId(taskId);
    if (!row || !TASK_RUNNING_STATUSES.has(row.status as TaskStatus)) return null;
    const cur = (row.agentTurnJson as AgentTurn | null) ?? null;
    if (cur?.triggerKey === triggerKey) return null;
    const nowDate = this.now();
    const nowIso = nowDate.toISOString();
    const turn: AgentTurn = { version: (cur?.version ?? 0) + 1, reason, observationKey: cur?.observationKey ?? "", summary: summary.slice(0, 500), requestedAt: nowIso, respondBy: new Date(nowDate.getTime() + AGENT_TURN_RESPOND_MS).toISOString(), state: "awaiting_agent", respondedAt: null, intentId: null, response: null, eventsKey: cur?.eventsKey ?? "", triggerKey, answeredRequestIds: cur?.answeredRequestIds ?? [] };
    const [updated] = await this.d.db.update(verifyTasks).set({ agentTurnJson: turn, ...(reason === "scheduled" ? { nextAgentCheckAt: null } : {}), updatedAt: nowDate }).where(eq(verifyTasks.id, row.id)).returning({ id: verifyTasks.id });
    if (!updated) return null;
    await appendTimeline(this.d.db, row.id, { at: nowIso, type: "agent_turn", note: `turn ${turn.version} (${reason}): ${summary}`.slice(0, 500), data: { turnVersion: turn.version, reason, triggerKey } }, "system");
    await this.d.notifier.emit(notificationPayload("task.agent_turn", row.id, turn.version, `your turn (${reason}): ${summary}`.slice(0, 500), `/agent/tasks/${row.id}`, nowIso), row.ownerAddress);
    return turn;
  }

  /** owner 改简报（策略文本 / 关注的事件）：在签名之外，不重签；策略留版本 */
  async updateBrief(callerId: string, id: string, raw: unknown): Promise<TaskRow> {
    const row = await this.requireTask(callerId, id);
    if (!scopeOf(row)) throw new HttpError(409, "scope_required", "该任务没有授权范围（建于 CV-D16 之前）");
    const b = (raw ?? {}) as Record<string, unknown>;
    const errors: Array<{ field: string; code: string }> = [];
    const brief: TaskBrief = (row.briefJson as TaskBrief | null) ?? { strategy: null, strategyHistory: [], currentPlan: null, watch: { kinds: [] }, agent: null, exampleId: null };
    const nowIso = this.now().toISOString();
    let next: TaskBrief = { ...brief };
    if (b["strategy"] !== undefined) {
      if (typeof b["strategy"] !== "string" || !b["strategy"].trim() || b["strategy"].length > STRATEGY_MAX_CHARS) errors.push({ field: "strategy", code: `expected_string_1_to_${STRATEGY_MAX_CHARS}` });
      else next = this.withStrategy(next, b["strategy"].trim(), "owner", nowIso, typeof b["note"] === "string" ? b["note"].slice(0, 300) : undefined);
    }
    if (b["watchEvents"] !== undefined) {
      const ks = (b["watchEvents"] && typeof b["watchEvents"] === "object" ? (b["watchEvents"] as { kinds?: unknown }).kinds : undefined);
      if (!Array.isArray(ks) || !ks.every((k) => typeof k === "string" && (EVENT_KINDS as readonly string[]).includes(k))) errors.push({ field: "watchEvents.kinds", code: `expected_subset_of_${EVENT_KINDS.join("|")}` });
      else next = { ...next, watch: { kinds: [...new Set(ks as string[])] } };
    }
    if (errors.length) throw new HttpError(400, "invalid_request", "简报校验失败", errors);
    const patched = (await this.patch(row.id, { briefJson: next, updatedAt: this.now() })) ?? row;
    return (await appendTimeline(this.d.db, row.id, { at: nowIso, type: "brief_updated", note: `${b["strategy"] !== undefined ? `strategy v${next.strategy?.version} by owner` : ""}${b["watchEvents"] !== undefined ? `${b["strategy"] !== undefined ? "; " : ""}watch: ${next.watch.kinds.join(",") || "none"}` : ""}` }, actorOf(callerId))).row ?? patched;
  }

  private withStrategy(brief: TaskBrief, text: string, by: "owner" | "agent", at: string, note?: string): TaskBrief {
    const version = (brief.strategy?.version ?? 0) + 1;
    const v: StrategyVersion = { version, text, by, at, ...(note ? { note } : {}) };
    return { ...brief, strategy: v, strategyHistory: [...brief.strategyHistory, v] };
  }

  /**
   * agent 回报状态：declined / needs_evidence / plan_revised / ended（都是正常结果）。
   * plan_revised → 走 updateConditions（计划在签名之外；硬约束触碰 → 409）；ended → 服务侧暂停（不撤销，owner 决定取消 / 链上撤销）。
   */
  async reportAgentStatus(callerId: string, id: string, raw: unknown): Promise<{ row: TaskRow; turn: AgentTurn; note: string; replayed?: boolean }> {
    const row0 = await this.requireTask(callerId, id, "agent_write");
    const scope = scopeOf(row0);
    if (!scope) throw new HttpError(409, "scope_required", "该任务没有授权范围（建于 CV-D16 之前）");
    const r = resolveAgentStatusReport(raw, { nowMs: this.now().getTime(), deadline: scope.deadline });
    if (!r.ok) throw new HttpError(400, "invalid_request", "agent 状态回报校验失败", r.errors);
    if (TASK_TERMINAL_STATUSES.has(row0.status as TaskStatus) || row0.status === "REVOKE_PENDING") throw new HttpError(409, "invalid_transition", `${row0.status} 不再接受 agent 状态`);
    const gate = await this.beginAgentAction(callerId, row0, raw, "status");
    if (gate.replay) return { row: row0, turn: (row0.agentTurnJson as AgentTurn | null) ?? this.syntheticTurn(r.report, this.now().toISOString()), note: "duplicate clientRequestId: already recorded", replayed: true };
    const report: AgentStatusReport = { ...r.report, ...(gate.binding.turnVersion !== undefined ? { turnVersion: gate.binding.turnVersion } : {}) };
    // 10/3 线上：declined 没带 nextCheckAt → nextAgentCheckAt 为空，scheduledTick 永远不会再叫醒这个任务。
    // declined / needs_evidence 缺 nextCheckAt 时给缺省（与 verify-agent 的兜底间隔相同），不超过授权期限
    if (!report.nextCheckAt && (report.status === "declined" || report.status === "needs_evidence")) {
      const at = this.now().getTime() + AGENT_DEFAULT_NEXT_CHECK_MS;
      if (at < Date.parse(scope.deadline)) report.nextCheckAt = new Date(at).toISOString();
    }
    const nowDate = this.now();
    const nowIso = nowDate.toISOString();
    let row = row0;
    let note = "recorded";
    if (report.status === "plan_revised" && report.plan?.conditions) {
      row = await this.applyConditions(row, { items: report.plan.conditions }, row.callerId);
      note = "plan conditions updated; the signed scope is unchanged";
    }
    // 简报：接管的 agent / 最近回应 / 当前计划（人话）/ 策略修订（留版本）
    const brief0: TaskBrief = (row.briefJson as TaskBrief | null) ?? { strategy: null, strategyHistory: [], currentPlan: null, watch: { kinds: [] }, agent: null, exampleId: null };
    let brief: TaskBrief = { ...brief0 };
    if (report.status === "accepted") brief = { ...brief, agent: { name: report.agent!.name, acceptedAt: brief.agent?.name === report.agent!.name ? brief.agent.acceptedAt : nowIso, lastResponseAt: nowIso } };
    else if (brief.agent || report.agent) brief = { ...brief, agent: { name: report.agent?.name ?? brief.agent!.name, acceptedAt: brief.agent?.acceptedAt ?? nowIso, lastResponseAt: nowIso } };
    if (report.plan?.text) brief = { ...brief, currentPlan: { text: report.plan.text, at: nowIso } };
    if (report.strategy) brief = this.withStrategy(brief, report.strategy, "agent", nowIso, report.note.slice(0, 300));
    if (report.status === "plan_revised" && !report.plan?.conditions) note = `${report.strategy ? `strategy v${brief.strategy?.version} by agent` : "current plan updated"}; the signed scope is unchanged`;
    const cur = (row.agentTurnJson as AgentTurn | null) ?? null;
    const answered = [...(cur?.answeredRequestIds ?? []), ...(report.clientRequestId ? [report.clientRequestId] : [])].slice(-20);
    // accepted = 接管，不算对当前轮次的回答（轮次仍等它的决定）；其它状态关闭当前轮次——v7：带 turnVersion 时只关闭同版本的轮次
    const closes = !!cur && report.status !== "accepted" && (report.turnVersion === undefined || report.turnVersion === cur.version);
    const turn: AgentTurn = cur
      ? closes ? { ...cur, state: report.status, respondedAt: nowIso, response: report, answeredRequestIds: answered } : { ...cur, answeredRequestIds: answered }
      : { ...this.syntheticTurn(report, nowIso), answeredRequestIds: answered };
    if (gate.hosted && report.status !== "accepted" && report.turnVersion !== undefined) await recordHostedTurnAction(this.d.db, row.id, report.turnVersion, { kind: "status", ref: `turn:${report.turnVersion}`, status: report.status, clientRequestId: report.clientRequestId ?? null }, nowDate);
    row = (await this.patch(row.id, { agentTurnJson: turn, briefJson: brief, ...(report.nextCheckAt && report.status !== "ended" ? { nextAgentCheckAt: new Date(report.nextCheckAt) } : {}), updatedAt: nowDate })) ?? row;
    // Lane R 的证据包按 type=agent_* + ref / turnVersion / clientRequestId 把状态动作对到时间线行
    const tlVersion = report.turnVersion ?? turn.version;
    const tl = await appendTimeline(this.d.db, row.id, { at: nowIso, type: `agent_${report.status}`, ref: `turn:${tlVersion}`, note: `${report.note}${report.requestedEvidence?.length ? ` · wants: ${report.requestedEvidence.join("; ")}` : ""}${report.nextCheckAt ? ` · next check ${report.nextCheckAt}` : ""}`.slice(0, AGENT_REPORT_NOTE_MAX), data: { turnVersion: tlVersion, status: report.status, ...(report.clientRequestId ? { clientRequestId: report.clientRequestId } : {}), ...(report.nextCheckAt ? { nextCheckAt: report.nextCheckAt } : {}), ...(report.invalidation ? { invalidation: report.invalidation } : {}) } }, actorOf(callerId));
    row = tl.row ?? row;
    await this.d.notifier.emit(notificationPayload("task.agent_status", row.id, tl.ids[0] ?? 0, `agent ${report.status}${brief.agent ? ` (${brief.agent.name})` : ""}: ${report.note}`.slice(0, 500), `/agent/tasks/${row.id}`, nowIso), row.ownerAddress);
    if (report.status === "ended" && TASK_RUNNING_STATUSES.has(row.status as TaskStatus)) {
      // v7：内部暂停（paused_by = agent），不走 owner 身份的 transition
      row = await this.pauseByAgent(row, report.note, actorOf(callerId));
      note = "task paused service-side on the agent's ended report (paused_by=agent): the owner resumes it or cancels and revokes on-chain (D-088); no new turns are opened";
      await this.d.notifier.emit(notificationPayload("task.needs_owner", row.id, (tl.ids[0] ?? 0) + 1, "the agent reported ended: resume to let it continue, or cancel and reclaim the allowance", `/agent/tasks/${row.id}`, nowIso), row.ownerAddress);
    }
    return { row, turn, note };
  }

  /** 没有打开的轮次时，agent 主动回报 → 合成一条（v6 行为） */
  private syntheticTurn(report: AgentStatusReport, nowIso: string): AgentTurn {
    const acc = report.status === "accepted";
    return { version: acc ? 0 : 1, reason: "observation_changed", observationKey: acc ? "" : "agent_initiated", summary: acc ? "" : "agent reported without an open turn", requestedAt: nowIso, respondBy: nowIso, state: acc ? "accepted" : report.status, respondedAt: acc ? null : nowIso, intentId: null, response: acc ? null : report };
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
    if (scopeOf(row0)?.issuance === "agent") throw new HttpError(409, "issuance_by_agent", "该任务由 agent 提交交易意图后签发（scope.issuance=agent）；prepare-step 不按计划签发");
    if (!this.d.cfg.agentC2) throw new HttpError(503, "agent_c2_disabled", "条件层已关闭（AGENT_C2_ENABLED=false）：不签发");
    const row = await this.evaluateTask(row0, { issue: true });
    const last = row.lastEvaluationJson as LastEvaluation | null;
    if (row.mode === "SIMULATION") {
      const ok = last?.outcome === "SATISFIED" && (last.simulation?.wouldIssue ?? false);
      return { httpStatus: ok ? 200 : 409, body: { status: ok ? "READY" : "WAIT", mode: "SIMULATION", taskId: id, taskStatus: row.status, blockers: row.blockersJson, nextCheckAt: row.nextCheckAt?.toISOString() ?? null, evaluation: last, certificate: null, note: "Simulation: conditions and rules ran on real evidence; no certificate was signed and nothing was executed." } };
    }
    if (row.status === "STEP_PREPARED" && last?.mandate) {
      const p = await this.d.mandates.prepareStep(callerId, last.mandate.mandateId, { viaTask: true });
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

  async onStepConfirmed(a: { mandateId: string; taskId: string | null; stepIndex: number; spentRaw: string; confirmedAt: Date; stepId?: string; side?: "buy" | "sell"; receivedRaw?: string }): Promise<void> {
    if (!a.taskId) return;
    const row = await this.byId(a.taskId);
    if (!row) return;
    const m = await this.d.mandates.byId(a.mandateId);
    // v7（D-092）：委托卖出授权的成交只更新 sell_steps_confirmed 与持仓——不碰资金组账目、不按 stepsPlanned 完成
    if (m && MandatesService.isDelegationSell(m)) return this.onSellStepConfirmed(row, a);
    await this.d.budget.onStepConfirmed(row.id, a.spentRaw);
    const stepsConfirmed = row.stepsConfirmed + 1;
    // v7：issuance=agent 的委托任务不再按 stepsPlanned 自动 COMPLETED（买入授权 COMPLETED ∧（不允许卖出 ∨ 净持仓 < dust））
    const agentRule = !!this.v7 && isDelegationTask(row) && scopeOf(row)?.issuance === "agent";
    const done = agentRule ? await this.v7!.agentTaskComplete({ ...row, stepsConfirmed }) : stepsConfirmed >= row.stepsPlanned;
    const [updated0] = await this.d.db.update(verifyTasks).set({ stepsConfirmed, lastConfirmedStepAt: a.confirmedAt, updatedAt: this.now() }).where(eq(verifyTasks.id, row.id)).returning();
    const updated = updated0 ? ((await appendTimeline(this.d.db, row.id, { at: a.confirmedAt.toISOString(), type: "step_confirmed", ref: `${a.mandateId}:${a.stepIndex}`, note: `spent ${a.spentRaw}`, data: { mandateId: a.mandateId, stepIndex: a.stepIndex, spentRaw: a.spentRaw } }, "system")).row ?? updated0) : undefined;
    await this.d.notifier.emit(notificationPayload("task.step_confirmed", row.id, stepsConfirmed, `step ${a.stepIndex} confirmed`, `/agent/tasks/${row.id}`, a.confirmedAt.toISOString()), row.ownerAddress);
    if (updated && scopeOf(updated)?.issuance === "agent" && !done) {
      const turn = await this.nextAgentTurn(updated, `step:${a.stepIndex}`, "step_confirmed", `step ${a.stepIndex} confirmed on-chain (spent ${a.spentRaw}); ${row.stepsPlanned - stepsConfirmed} planned step(s) left inside your scope`, this.now());
      if (turn) await this.patch(updated.id, { agentTurnJson: turn });
    }
    if (updated && (TASK_RUNNING_STATUSES.has(updated.status as TaskStatus) || updated.status === "PAUSED")) {
      if (done) {
        await this.d.budget.release(row.id, "completed");
        await this.setStatus(updated, "COMPLETED", agentRule ? "buy authorization completed and no task position left to sell" : `all ${row.stepsPlanned} steps confirmed`);
      } else if (updated.status !== "PAUSED") await this.setStatus(updated, "PARTIAL", `${stepsConfirmed}/${row.stepsPlanned} steps confirmed`);
    }
  }

  /** v7 卖出步骤确认：sell_steps_confirmed + 时间线 + 通知 + step_confirmed 轮次；完成条件按委托任务规则复查 */
  private async onSellStepConfirmed(row: TaskRow, a: { mandateId: string; stepIndex: number; spentRaw: string; confirmedAt: Date; receivedRaw?: string }): Promise<void> {
    const [u0] = await this.d.db.update(verifyTasks).set({ sellStepsConfirmed: row.sellStepsConfirmed + 1, lastConfirmedStepAt: a.confirmedAt, updatedAt: this.now() }).where(eq(verifyTasks.id, row.id)).returning();
    const updated = u0 ? ((await appendTimeline(this.d.db, row.id, { at: a.confirmedAt.toISOString(), type: "step_confirmed", ref: `${a.mandateId}:${a.stepIndex}`, note: `sell: spent ${a.spentRaw} (stock units), received ${a.receivedRaw ?? "?"}`, data: { mandateId: a.mandateId, stepIndex: a.stepIndex, side: "sell", spentRaw: a.spentRaw, receivedRaw: a.receivedRaw ?? null } }, "system")).row ?? u0) : undefined;
    await this.d.notifier.emit(notificationPayload("task.step_confirmed", row.id, row.stepsConfirmed + row.sellStepsConfirmed + 1, `sell step ${a.stepIndex} confirmed`, `/agent/tasks/${row.id}`, a.confirmedAt.toISOString()), row.ownerAddress);
    if (!updated) return;
    if (scopeOf(updated)?.issuance === "agent") {
      const turn = await this.nextAgentTurn(updated, `sell:${a.mandateId}:${a.stepIndex}`, "step_confirmed", `sell step ${a.stepIndex} confirmed on-chain (spent ${a.spentRaw} stock units)`, this.now());
      if (turn) await this.patch(updated.id, { agentTurnJson: turn });
    }
    if (TASK_RUNNING_STATUSES.has(updated.status as TaskStatus) && this.v7 && (await this.v7.agentTaskComplete(updated))) {
      await this.d.budget.release(row.id, "completed");
      await this.setStatus(updated, "COMPLETED", "buy authorization completed and no task position left to sell");
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
      await this.d.db.update(verifyTasks).set({ exitDraftJson: draft, updatedAt: this.now() }).where(eq(verifyTasks.id, row.id));
      await appendTimeline(this.d.db, row.id, { at: nowIso, type: "exit_draft", note: "thesis invalidated → sell draft generated; requires a NEW authorization (nothing is sold automatically)" }, "system");
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
