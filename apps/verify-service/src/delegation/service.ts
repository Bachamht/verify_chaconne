/**
 * v7 委托仪式（P0-A，开发计划 §2.2–§2.4，D-091 / D-092）：
 *   建任务时的 agent / executor 模式与准入、卖出草案（目标式买入 + allowSell）；委托清单（GET 时为需要的 permit 登记 ISSUED 请求）；
 *   POST /allowances（§2.3 全部校验 + 代付限制）→ permit 作业（执行身份代付上链）；permit 确认 → buyReady / complete；
 *   owner 维度额度视图与收回；接管切换；任务持仓；运行态（needsOwner / needsOperator / executor）。
 * 服务端永不代签 TradeMandate / permit；permit 发放值 ≤ 账本需要量 + 0.5%，不存在无限额度。
 */
import { and, desc, eq, gt, gte, inArray, isNotNull, ne } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { FEE_BUDGET_LOCK_KEY, FEE_OPERATOR_CODES, type FeeBudget } from "../execution/fees";
import { recoverTypedDataAddress, type Hex } from "viem";
import type { Db } from "@chaconne/db";
import { verifyExecutionJobs, verifyExecutorStatus, verifyMandates, verifyPermits, verifyTasks } from "@chaconne/db";
import {
  buildDelegationChecklist,
  checklistLatches,
  EIP712_TYPES_V2,
  EXECUTOR_MODES,
  explainBuyMandate,
  explainPermit,
  explainSellMandate,
  findEntry,
  findPolicy,
  makePlanGuardDomain,
  mandateItemId,
  outputSetHash,
  permitDeadline,
  permitFromTypedData,
  permitItemId,
  permitTypedData,
  permitValue,
  reclaimSuggested,
  reclaimValue,
  registryHash,
  requiredAllowance,
  resolveParams,
  sellCapRaw,
  TASK_TERMINAL_STATUSES,
  type AgentMode,
  type AssetRegistry,
  type ChecklistMandateInput,
  type ChecklistPermitInput,
  type DelegationChecklist,
  type Eip712TypedData,
  type EvmAddress,
  type ExecutorMode,
  type ExecutorStatus,
  type LedgerDraft,
  type LedgerMandate,
  type NeedsOperatorCode,
  type NeedsOwnerItem,
  type PermitJobPayload,
  type Reason,
  type TaskScope,
  type TaskStatus,
  type TradeMandate,
} from "@chaconne/core/verify";
import type { VerifyConfig } from "../config";
import { HttpError } from "../jobs/service";
import { log } from "../log";
import { callerActsFor } from "../http/auth";
import { appendTimeline, actorOf } from "../records/timeline";
import { MandatesService, policyWithConditions, type MandateJson, type MandateRow, type StepRow } from "../mandates/service";
import type { Orders } from "../payments/orders";
import type { ServiceChain } from "../execution/chain";
import { v7Id, type ExecutionJobs } from "../execution/jobs";
import type { OpsState } from "../execution/ops";
import { taskPositions, type TaskPosition } from "../portfolio/taskPositions";
import { bindingHashOf, scopeOf, type TaskRow, type TasksService } from "../tasks/service";
import { composeTaskRuntime, isDelegationTask, NEEDS_OWNER_TEXT, type TasksV7Hooks, type V7CreateInput, type V7CreateResult } from "../tasks/runtime";
import { verifyTaskIntents } from "@chaconne/db";
import type { ExecutionJobState, NeedsOperatorCode as NOC, TaskRuntime } from "@chaconne/core/verify";
import { notificationPayload } from "../tasks/notify";
import type { PermitDomains } from "./domains";

export type PermitRow = typeof verifyPermits.$inferSelect;

export interface SellItem {
  itemId: string;
  assetKey: string;
  token: string;
  decimals: number;
  sellCapRaw: string | null;
  p6: string | null;
  nonce: string;
  draft: { mandate: TradeMandate; typedData: Eip712TypedData; registerBody: Record<string, unknown>; effectivePolicyHash: string } | null;
  error: { code: string; message: string } | null;
}
export interface DelegationState {
  v: "delegation/1";
  sells: SellItem[];
  latched: Record<string, "confirmed" | "not_needed">;
  buyReadyAt: string | null;
  completeAt: string | null;
}

/** Lane A AgentRuntime 暴露给 Lane X 的钩子（只用到这四个） */
export interface AgentHooksForX {
  onAssigned(taskId: string): Promise<unknown>;
  onAuthorized(taskId: string): Promise<unknown>;
  onExecutionFailed(taskId: string, info: { jobId: string; intentId?: string | null; errorCode?: string | null; revertClass?: string | null; consecutivePaidFailures?: number; autoRetryPaused?: boolean }): Promise<unknown>;
  needsOperatorFor(taskId: string): Promise<NOC[]>;
}

export interface DelegationDeps {
  db: Db;
  cfg: VerifyConfig;
  registry: AssetRegistry;
  tasks: TasksService;
  mandates: MandatesService;
  orders: Orders;
  jobs: ExecutionJobs | null;
  chain: ServiceChain | null;
  ops: OpsState;
  domains: PermitDomains;
  /** 执行身份费用预算（D-089 修订）：permit 代付受理时与限频同一事务预检 */
  fees?: FeeBudget | null;
  /** Lane A 托管 Agent 运行时的钩子（开轮次 / 运营者需要处理的项）；未装配 = 不开轮次 */
  agent?: AgentHooksForX | null;
  /** 「100 USDG 档」可执行单价 × 1e6（P6）；不可得 → null（卖出项 failed{price_unavailable}） */
  p6For?: (assetKey: string) => Promise<string | null>;
  now?: () => Date;
}

export class DelegationService implements TasksV7Hooks {
  private readonly now: () => Date;
  private nonceSeq = 0;
  constructor(private readonly d: DelegationDeps) {
    this.now = d.now ?? (() => new Date());
  }
  private planGuard(): EvmAddress {
    const a = this.d.cfg.PLANGUARD_ADDRESS;
    if (!a) throw new HttpError(503, "planguard_not_configured");
    return a.toLowerCase() as EvmAddress;
  }
  private allowlisted(owner: string): boolean {
    const al = this.d.cfg.v7.hostedOwnerAllowlist;
    return al === null || al.has(owner.toLowerCase());
  }
  private stateOf(row: TaskRow): DelegationState {
    return (row.delegationJson as DelegationState | null) ?? { v: "delegation/1", sells: [], latched: {}, buyReadyAt: null, completeAt: null };
  }
  private async saveState(taskId: string, st: DelegationState): Promise<void> {
    await this.d.db.update(verifyTasks).set({ delegationJson: st, updatedAt: this.now() }).where(eq(verifyTasks.id, taskId));
  }

  /* ================= 建任务 ================= */

  async prepareCreate(a: V7CreateInput): Promise<V7CreateResult | null> {
    const cfg = this.d.cfg.v7;
    const ag = a.body["agent"] && typeof a.body["agent"] === "object" ? (a.body["agent"] as { mode?: unknown }).mode : undefined;
    const ex = a.body["executor"] && typeof a.body["executor"] === "object" ? (a.body["executor"] as { mode?: unknown }).mode : undefined;
    const agentMode: AgentMode | null = ag === undefined || ag === null ? null : ag === "hosted" || ag === "byo" ? ag : (() => { throw new HttpError(400, "invalid_request", "agent.mode 必须是 hosted | byo", [{ field: "agent.mode", code: "expected_hosted|byo" }]); })();
    const executorMode: ExecutorMode | null = ex === undefined || ex === null ? null : (EXECUTOR_MODES as readonly unknown[]).includes(ex) ? (ex as ExecutorMode) : (() => { throw new HttpError(400, "invalid_request", "executor.mode 必须是 hosted | agent_wallet | browser", [{ field: "executor.mode", code: "expected_hosted|agent_wallet|browser" }]); })();
    if (!cfg.delegation && !agentMode && !executorMode) return null;
    if (agentMode === "hosted" && !cfg.hostedAgent) throw new HttpError(503, "hosted_disabled", "托管 Agent 尚未开放（HOSTED_AGENT_ENABLED=false）");
    if (executorMode === "hosted" && !cfg.hostedExecutor) throw new HttpError(503, "hosted_disabled", "平台执行尚未开放（HOSTED_EXECUTOR_ENABLED=false）");
    if (executorMode === "hosted" && a.mode !== "LIVE") throw new HttpError(400, "invalid_request", "SIMULATION 任务不执行，不能选平台执行", [{ field: "executor.mode", code: "simulation_has_no_executor" }]);
    const hosted = agentMode === "hosted" || executorMode === "hosted";
    if (hosted && a.mode === "LIVE" && !this.allowlisted(a.owner)) throw new HttpError(403, "hosted_not_allowed", "托管运行暂未对该钱包开放（HOSTED_OWNER_ALLOWLIST）；可先用观察模式（SIMULATION）");
    if (agentMode === "hosted" && a.mode === "SIMULATION") {
      const dayStart = new Date(Date.UTC(a.nowDate.getUTCFullYear(), a.nowDate.getUTCMonth(), a.nowDate.getUTCDate()));
      const n = (await this.d.db.select({ id: verifyTasks.id }).from(verifyTasks).where(and(eq(verifyTasks.ownerAddress, a.owner.toLowerCase()), eq(verifyTasks.agentMode, "hosted"), eq(verifyTasks.mode, "SIMULATION"), gte(verifyTasks.createdAt, dayStart)))).length;
      if (n >= this.d.cfg.HOSTED_SIM_PER_OWNER_PER_DAY) throw new HttpError(429, "hosted_sim_limit", `观察模式每个钱包每天最多 ${this.d.cfg.HOSTED_SIM_PER_OWNER_PER_DAY} 个托管任务`);
    }
    const sellEligible = cfg.delegation && cfg.sell && a.mode === "LIVE" && a.goalMode && a.scope.issuance === "agent" && a.scope.allowSell;
    if ((sellEligible || executorMode === "hosted") && a.recipient.toLowerCase() !== a.owner.toLowerCase()) throw new HttpError(400, "recipient_must_be_owner", "允许卖出或平台执行的任务要求收款人 = owner（买入送到 recipient、卖出从 owner 拉款）", [{ field: "recipientAddress", code: "recipient_must_be_owner" }]);
    let delegationJson: DelegationState | null = null;
    // 委托仪式只对选择了 v7 模式（agent / executor）的 LIVE 任务生效；旧客户端（不带模式）保持 v6 授权流程
    if (cfg.delegation && a.mode === "LIVE" && (agentMode !== null || executorMode !== null)) {
      const sells = sellEligible ? await Promise.all(a.scope.outputAssetKeys.map((k, i) => this.buildSellItem({ taskId: a.taskId, owner: a.owner, scope: a.scope, scopeHash: a.scopeHash, goal: a.goal, assetKey: k, idx: i }))) : [];
      delegationJson = { v: "delegation/1", sells, latched: {}, buyReadyAt: null, completeAt: null };
    }
    return { agentMode, executorMode, delegationJson: delegationJson as unknown as Record<string, unknown> | null };
  }

  /**
   * 卖出草案（§2.4，D-092 运营者确认 2026-10-02 简化）：inputToken = 股票，outputSet = [资金币种]，recipient = owner，
   * budgetCap = perStepCap = sellCapRaw = 委托时链上该股票余额（已有持仓）+ 预算在价格腰斩时可买份额。余额读不到 → failed{balance_unavailable}。
   */
  private async buildSellItem(a: { taskId: string; owner: string; scope: V7CreateInput["scope"]; scopeHash: string; goal: V7CreateInput["goal"]; assetKey: string; idx: number }): Promise<SellItem> {
    const stock = findEntry(this.d.registry, a.assetKey)!;
    const stable = findEntry(this.d.registry, a.scope.inputAssetKey)!;
    const itemId = mandateItemId("sell", stock.assetKey);
    // nonce：同一 owner 内唯一（毫秒 × 100 + 序号，登记前查重）
    const nonce = (BigInt(this.now().getTime()) * 100n + 50n + BigInt((a.idx + this.nonceSeq++) % 50)).toString();
    const base: SellItem = { itemId, assetKey: stock.assetKey.toLowerCase(), token: stock.tokenAddress.toLowerCase(), decimals: stock.tokenDecimals, sellCapRaw: null, p6: null, nonce, draft: null, error: null };
    const p6 = this.d.p6For ? await this.d.p6For(stock.assetKey).catch(() => null) : null;
    const holdings = this.d.chain ? await this.d.chain.balanceOf(stock.tokenAddress as EvmAddress, a.owner as EvmAddress).catch(() => null) : null;
    if (holdings === null) return { ...base, error: { code: "balance_unavailable", message: "could not read your on-chain balance of this stock; refresh to retry" } };
    const cap = sellCapRaw({ budgetCapRaw: a.scope.budgetCapRaw, stableDecimals: stable.tokenDecimals, tokenDecimals: stock.tokenDecimals, p6, holdingsRaw: holdings.toString() });
    if (!cap.ok) return { ...base, error: { code: cap.code, message: cap.message } };
    const def = findPolicy(a.goal.policyId as never, a.goal.policyVersion);
    if (!def) return { ...base, error: { code: "unknown_policy", message: "policy not found" } };
    const resolved = resolveParams(def, { maxSlippageBps: a.goal.maxSlippageBps, maxPriceImpactBps: a.goal.maxPriceImpactBps, maxReferenceDeviationBps: a.goal.policyId === "QUOTE_ONLY" ? null : (a.goal.maxReferenceDeviationBps ?? null) });
    if (!resolved.ok) return { ...base, error: { code: "policy_param_out_of_range", message: "policy params out of range" } };
    const policy = policyWithConditions(def, resolved.params, a.scopeHash as `0x${string}`);
    const planGuard = this.planGuard();
    const mandate: TradeMandate = {
      owner: a.owner.toLowerCase() as EvmAddress,
      recipient: a.owner.toLowerCase() as EvmAddress,
      inputToken: stock.tokenAddress.toLowerCase() as EvmAddress,
      outputSetHash: outputSetHash([stable.tokenAddress as EvmAddress]),
      budgetCap: cap.sellCapRaw,
      perStepCap: cap.sellCapRaw,
      maxSteps: String(a.scope.maxSteps),
      policyDefinitionHash: policy.policyDefinitionHash,
      effectivePolicyHash: policy.effectivePolicyHash,
      registryHash: registryHash(this.d.registry),
      validFrom: String(Math.floor(this.now().getTime() / 1000) - 60),
      deadline: String(Math.floor(Date.parse(a.scope.deadline) / 1000)),
      nonce,
    };
    const domain = makePlanGuardDomain(this.d.cfg.EXECUTION_CHAIN_ID, planGuard);
    // registerBody 约定（9/22）：side=sell 时 inputAssetKey 存资金币种、legs[0] 存股票
    const registerBody = { inputAssetKey: stable.assetKey, legs: [{ outputAssetKey: stock.assetKey, weightBps: 10_000 }], side: "sell", policyId: a.goal.policyId, policyVersion: a.goal.policyVersion, maxSlippageBps: resolved.params.maxSlippageBps, maxPriceImpactBps: resolved.params.maxPriceImpactBps, maxReferenceDeviationBps: resolved.params.maxReferenceDeviationBps, conditionsHash: a.scopeHash, sku: "task_bundle" };
    return { ...base, sellCapRaw: cap.sellCapRaw, p6: cap.p6, draft: { mandate, typedData: { domain, types: EIP712_TYPES_V2 as unknown as Eip712TypedData["types"], primaryType: "TradeMandate", message: mandate as unknown as Record<string, unknown> }, registerBody, effectivePolicyHash: policy.effectivePolicyHash } };
  }

  /** POST /v1/tasks/:id/delegation/refresh：重建失败的卖出草案 */
  async refreshSells(callerId: string, taskId: string): Promise<DelegationChecklist> {
    const row = await this.d.tasks.requireTask(callerId, taskId, "owner_write");
    if (!isDelegationTask(row)) throw new HttpError(409, "not_delegation_task");
    const st = this.stateOf(row);
    const scope = scopeOf(row)!;
    const goal = row.goalJson as V7CreateInput["goal"];
    st.sells = await Promise.all(st.sells.map(async (s, i) => (s.draft ? s : this.buildSellItem({ taskId, owner: row.ownerAddress, scope: scope as unknown as V7CreateInput["scope"], scopeHash: bindingHashOf(row), goal, assetKey: s.assetKey, idx: i }))));
    await this.saveState(taskId, st);
    return this.checklist(callerId, taskId, { issue: false });
  }

  /* ================= 授权（sell） ================= */

  async authorizeSell(callerId: string, row: TaskRow, itemId: string, b: Record<string, unknown>): Promise<{ row: TaskRow; mandate: Record<string, unknown> }> {
    if (!this.d.cfg.v7.sell) throw new HttpError(503, "hosted_disabled", "自主减仓尚未开放（AGENT_V7_SELL_ENABLED=false）");
    const st = this.stateOf(row);
    const item = st.sells.find((s) => s.itemId === itemId.toLowerCase() || s.itemId === itemId);
    if (!item) throw new HttpError(404, "item_not_found", `委托清单里没有 ${itemId}`);
    if (!item.draft) throw new HttpError(409, "sell_draft_failed", `卖出草案生成失败（${item.error?.code ?? "unknown"}）：先 POST /v1/tasks/:id/delegation/refresh`);
    const fromTyped = b["typedData"] && typeof b["typedData"] === "object" ? ((b["typedData"] as { message?: unknown }).message ?? null) : null;
    const mandate = (b["mandate"] && typeof b["mandate"] === "object" ? b["mandate"] : (fromTyped ?? item.draft.mandate)) as TradeMandate;
    if (String(mandate.effectivePolicyHash).toLowerCase() !== item.draft.effectivePolicyHash.toLowerCase()) throw new HttpError(422, "mandate_rejected", "卖出授权的 effectivePolicyHash 与任务范围不一致", [{ field: "mandate.effectivePolicyHash", code: "scope_hash_mismatch" }]);
    // nonce 查重：同一 owner 内唯一
    const r = await this.d.mandates.register(callerId, { ...item.draft.registerBody, clientRequestId: `${row.id}:auth:${item.itemId}`, mandate, signature: b["signature"], conditionsHash: bindingHashOf(row) }, { taskId: row.id, delegationItemId: item.itemId, fromBlock: await this.fromBlock() });
    const order = await this.d.orders.byRef(r.row.id);
    if (order && (order.priceUsd === "0" || this.d.orders.isDeliverable(order))) {
      await this.d.mandates.activate(r.row.id);
      if (order.state !== "DELIVERED") await this.d.orders.markDelivered(order.id);
    }
    const mrow = (await this.d.mandates.byId(r.row.id))!;
    // 卖出授权从不触碰资金组账目：不 reserve
    const cur = (await this.d.tasks.byId(row.id))!;
    if (!cur.mandateIds.includes(mrow.id)) await this.d.db.update(verifyTasks).set({ mandateIds: [...cur.mandateIds, mrow.id], updatedAt: this.now() }).where(eq(verifyTasks.id, row.id));
    if (r.status === 201) await appendTimeline(this.d.db, row.id, { at: this.now().toISOString(), type: "authorized", ref: mrow.id, note: `sell authorization ${item.itemId} → mandate ${mrow.id} ${mrow.state} (contract cap ${item.sellCapRaw})`, data: { itemId: item.itemId, mandateId: mrow.id, side: "sell" } }, actorOf(callerId));
    const updated = (await this.refreshDelegation(row.id)) ?? cur;
    return { row: updated, mandate: await this.d.mandates.view(mrow) };
  }

  async fromBlock(): Promise<string | null> {
    if (!this.d.chain) return null;
    try {
      return (await this.d.chain.head()).number.toString();
    } catch {
      return null;
    }
  }

  /* ================= 清单 ================= */

  private registeredFor(mandates: MandateRow[], itemId: string): MandateRow | null {
    return [...mandates].reverse().find((m) => (m.mandateJson as MandateJson).delegationItemId === itemId) ?? null;
  }

  /** 该 owner 在这个 PlanGuard 上的未终结授权（账本用；所有任务） */
  private async ownerLedgerMandates(owner: string): Promise<LedgerMandate[]> {
    // 已过期的授权链上无法再执行（PlanGuard 检查 deadline），不再占用额度；库里的状态不会自动转成 EXPIRED，所以按 deadline 过滤
    const rows = await this.d.db.select().from(verifyMandates).where(and(eq(verifyMandates.ownerAddress, owner.toLowerCase()), inArray(verifyMandates.state, ["DRAFT", "ACTIVE", "PAUSED"]), gt(verifyMandates.deadline, this.now())));
    return rows.map((m) => ({ mandateId: m.id, token: (m.mandateJson as MandateJson).mandate.inputToken.toLowerCase() as EvmAddress, state: m.state, budgetCap: m.budgetCap, spent: m.spent }));
  }

  private async onchainAllowance(token: string, owner: string): Promise<string> {
    if (!this.d.chain) throw new HttpError(503, "chain_unavailable", "读不到链上额度（XLAYER_RPC_URL 不可用）");
    return (await this.d.chain.allowance(token as EvmAddress, owner as EvmAddress, this.planGuard())).toString();
  }

  /** 计算清单；issue = true 时为需要的 permit 项登记 ISSUED 请求（GET /delegation） */
  async checklistFor(row: TaskRow, opts: { issue: boolean }): Promise<DelegationChecklist> {
    const st = this.stateOf(row);
    const scope = scopeOf(row) as TaskScope;
    const planGuard = this.planGuard();
    const mandates = row.mandateIds.length ? await this.d.db.select().from(verifyMandates).where(inArray(verifyMandates.id, row.mandateIds)) : [];
    const stable = findEntry(this.d.registry, scope.inputAssetKey)!;
    const draft = row.mandateDraftJson as { mandate: TradeMandate; typedData: Eip712TypedData } | null;
    const buyReg = this.registeredFor(mandates, "buy") ?? mandates.find((m) => !MandatesService.isDelegationSell(m) && m.conditionsHash === bindingHashOf(row)) ?? null;
    const stocks = scope.outputAssetKeys.map((k) => findEntry(this.d.registry, k)!.displaySymbol);
    const mInputs: ChecklistMandateInput[] = [
      { ...explainBuyMandate({ stableSymbol: stable.displaySymbol, stableDecimals: stable.tokenDecimals, budgetCapRaw: scope.budgetCapRaw, perStepCapRaw: scope.perStepCapRaw, maxSteps: scope.maxSteps, stockSymbols: stocks, deadline: scope.deadline, planGuard }), side: "buy", assetKey: stable.assetKey, token: stable.tokenAddress.toLowerCase() as EvmAddress, typedData: draft?.typedData ?? null, registered: buyReg ? { mandateId: buyReg.id, state: buyReg.state } : null },
      ...st.sells.map((s): ChecklistMandateInput => {
        const reg = this.registeredFor(mandates, s.itemId);
        const stock = findEntry(this.d.registry, s.assetKey)!;
        return { ...explainSellMandate({ stockSymbol: stock.displaySymbol, stockDecimals: stock.tokenDecimals, stableSymbol: stable.displaySymbol, sellCapRaw: s.sellCapRaw, deadline: scope.deadline, planGuard }), side: "sell", assetKey: s.assetKey, token: s.token as EvmAddress, typedData: s.draft?.typedData ?? null, registered: reg ? { mandateId: reg.id, state: reg.state } : null, error: s.error };
      }),
    ];
    // 账本：该 owner 全部未终结授权 + 本任务未登记草案
    const ledger = await this.ownerLedgerMandates(row.ownerAddress);
    const drafts: LedgerDraft[] = [];
    if (!buyReg) drafts.push({ id: "buy", token: stable.tokenAddress.toLowerCase() as EvmAddress, budgetCap: scope.budgetCapRaw });
    for (const s of st.sells) if (s.sellCapRaw && !this.registeredFor(mandates, s.itemId)) drafts.push({ id: s.itemId, token: s.token as EvmAddress, budgetCap: s.sellCapRaw });
    const tokens = [...new Set(mInputs.map((m) => m.token.toLowerCase()))];
    const records = await this.d.db.select().from(verifyPermits).where(and(eq(verifyPermits.taskId, row.id), eq(verifyPermits.purpose, "delegation"))).orderBy(desc(verifyPermits.createdAt));
    const pInputs: ChecklistPermitInput[] = [];
    for (const token of tokens) {
      const e = this.d.registry.entries.find((x) => x.tokenAddress.toLowerCase() === token)!;
      const onchainRaw = await this.onchainAllowance(token, row.ownerAddress);
      const requiredRaw = requiredAllowance(ledger, drafts, token as EvmAddress);
      const latest = records.find((r) => r.tokenAddress === token && r.state !== "ISSUED" && r.state !== "SUPERSEDED") ?? null;
      const pendingPermit = !!(await this.d.jobs?.inflightPermit(row.ownerAddress, token));
      const lastJob = latest?.jobId ? await this.d.jobs?.byId(latest.jobId) : null;
      pInputs.push({ ...explainPermit({ symbol: e.displaySymbol, decimals: e.tokenDecimals, valueRaw: permitValue(requiredRaw), requiredRaw, planGuard }), token: token as EvmAddress, assetKey: e.assetKey, onchainRaw, requiredRaw, supported: this.d.domains.supported(token), issued: null, latest: latest ? { permitId: latest.id, state: latest.state, txHash: (latest.txHash as Hex | null) ?? null, error: latest.state === "FAILED" ? { code: lastJob?.errorCode ?? "permit_failed", message: "the allowance signature did not land on-chain" } : null } : null, pendingPermit });
    }
    let c = buildDelegationChecklist({ taskId: row.id, mandates: mInputs, permits: pInputs, latched: st.latched });
    if (opts.issue) {
      let issuedAny = false;
      for (const p of pInputs) {
        const item = c.items.find((i) => i.id === permitItemId(p.token));
        if (!item || item.status !== "todo" || !p.supported) continue;
        const issued = await this.issuePermit({ taskId: row.id, itemId: item.id, owner: row.ownerAddress, token: p.token, value: permitValue(p.requiredRaw), purpose: "delegation" });
        p.issued = { permitRequestId: issued.id, typedData: issued.typedDataJson as Eip712TypedData };
        issuedAny = true;
      }
      if (issuedAny) c = buildDelegationChecklist({ taskId: row.id, mandates: mInputs, permits: pInputs, latched: st.latched });
    }
    const latches = checklistLatches(c);
    if (Object.keys(latches).some((k) => st.latched[k] !== latches[k])) await this.saveState(row.id, { ...st, latched: { ...st.latched, ...latches } });
    return c;
  }

  async checklist(callerId: string, taskId: string, opts: { issue: boolean }): Promise<DelegationChecklist> {
    const row = await this.d.tasks.requireTask(callerId, taskId, "read");
    if (!isDelegationTask(row)) throw new HttpError(409, "not_delegation_task", "该任务不是 v7 委托任务（建于 AGENT_V7_DELEGATION_ENABLED 之前或 SIMULATION）");
    return this.checklistFor(row, opts);
  }

  /** 登记一条 ISSUED permit 请求（nonce 读链、deadline = now + 1800、value ≤ 需要量 + 0.5%）；同任务同代币旧的 ISSUED → SUPERSEDED */
  private async issuePermit(a: { taskId: string | null; itemId: string | null; owner: string; token: string; value: string; purpose: "delegation" | "reclaim" }): Promise<PermitRow> {
    const domain = this.d.domains.domain(a.token);
    if (!domain) throw new HttpError(409, "permit_domain_unverified", "该代币的 permit 域未核实：只能走一笔用户 approve");
    if (!this.d.chain) throw new HttpError(503, "chain_unavailable");
    const nonce = (await this.d.chain.nonces(a.token as EvmAddress, a.owner as EvmAddress)).toString();
    const nowDate = this.now();
    const deadline = permitDeadline(Math.floor(nowDate.getTime() / 1000));
    const td = permitTypedData(domain, { owner: a.owner.toLowerCase() as EvmAddress, spender: this.planGuard(), value: a.value, nonce, deadline });
    await this.d.db.update(verifyPermits).set({ state: "SUPERSEDED", updatedAt: nowDate }).where(and(eq(verifyPermits.ownerAddress, a.owner.toLowerCase()), eq(verifyPermits.tokenAddress, a.token.toLowerCase()), eq(verifyPermits.state, "ISSUED"), eq(verifyPermits.purpose, a.purpose), ...(a.taskId ? [eq(verifyPermits.taskId, a.taskId)] : [])));
    const [row] = await this.d.db.insert(verifyPermits).values({ id: v7Id("prm"), taskId: a.taskId, itemId: a.itemId, ownerAddress: a.owner.toLowerCase(), tokenAddress: a.token.toLowerCase(), spender: this.planGuard(), value: a.value, nonce, deadline, typedDataJson: td, signature: null, purpose: a.purpose, jobId: null, state: "ISSUED", txHash: null, allowanceAfter: null, createdAt: nowDate, updatedAt: nowDate }).returning();
    return row!;
  }

  /* ================= 提交签名 ================= */

  /** POST /v1/tasks/:id/allowances 与 POST /v1/owners/:owner/allowances/submit 共用（§2.3 全部校验 + 代付限制） */
  async submitPermit(callerId: string, a: { taskId: string | null; owner?: string }, body: Record<string, unknown>): Promise<{ permitId: string; jobId: string; state: string }> {
    const permitRequestId = typeof body["permitRequestId"] === "string" ? body["permitRequestId"] : "";
    const signature = typeof body["signature"] === "string" && /^0x[0-9a-fA-F]{130}$/.test(body["signature"]) ? (body["signature"] as Hex) : null;
    if (!permitRequestId || !signature) throw new HttpError(400, "invalid_request", "需要 { permitRequestId, signature }", [{ field: !permitRequestId ? "permitRequestId" : "signature", code: "required" }]);
    let task: TaskRow | null = null;
    let owner: string;
    if (a.taskId) {
      task = await this.d.tasks.requireTask(callerId, a.taskId, "owner_write");
      owner = task.ownerAddress;
    } else {
      owner = (a.owner ?? "").toLowerCase();
      if (!callerActsFor(callerId, owner)) throw new HttpError(403, "owner_forbidden", "只有该钱包本人（网站会话或它签发的 key）能收回额度");
    }
    const p = (await this.d.db.select().from(verifyPermits).where(eq(verifyPermits.id, permitRequestId)).limit(1))[0];
    if (!p || (a.taskId ? p.taskId !== a.taskId : p.taskId !== null || p.ownerAddress !== owner)) throw new HttpError(404, "permit_request_not_found", "permitRequestId 不存在或不属于本任务");
    // 409 码与网页向导约定（自动重取）：permit_request_expired / permit_pending / permit_not_needed / permit_nonce_stale
    if (p.state === "SUBMITTED") throw new HttpError(409, "permit_pending", "这份额度请求已提交，正在上链");
    if (p.state === "CONFIRMED") throw new HttpError(409, "permit_not_needed", "这份额度请求已上链");
    if (p.state !== "ISSUED") throw new HttpError(409, "permit_request_expired", `该请求状态 ${p.state}（已被新请求取代或失败）：重新 GET`);
    const nowSec = Math.floor(this.now().getTime() / 1000);
    if (Number(p.deadline) - 120 <= nowSec) throw new HttpError(409, "permit_request_expired", "签名可提交的截止时间已近：重新 GET 取新请求");
    if (body["value"] !== undefined && String(body["value"]) !== p.value) throw new HttpError(422, "permit_value_mismatch", "value 以 GET 时发放的为准");
    // 代付限制：只为平台执行任务 + 白名单 owner；每 owner 每小时、全局每天上限
    if (task && task.executorMode !== "hosted") throw new HttpError(403, "relay_not_allowed", "只有选择平台执行的任务由执行身份代付 permit 上链");
    if (!this.d.cfg.v7.hostedExecutor) throw new HttpError(503, "hosted_disabled", "平台执行尚未开放（HOSTED_EXECUTOR_ENABLED=false）");
    if (!this.allowlisted(owner)) throw new HttpError(403, "relay_not_allowed", "该钱包不在托管白名单（HOSTED_OWNER_ALLOWLIST）");
    // 限频与费用预检在入队事务里原子完成（见下方「入队」）；这里不先查后写
    // 签名必须由 owner 对 ISSUED 的那份 typedData 签出（错 owner / 错 spender / 改过的 value 都恢复不出 owner）
    const td = p.typedDataJson as Eip712TypedData;
    const { domain, message } = permitFromTypedData(td);
    if (message.spender.toLowerCase() !== this.planGuard() || message.owner.toLowerCase() !== owner) throw new HttpError(422, "permit_typed_data_invalid", "permit 的 owner / spender 不对");
    const recovered = await recoverTypedDataAddress({ domain: { name: domain.name, ...(domain.version !== null ? { version: domain.version } : {}), chainId: domain.chainId, verifyingContract: domain.verifyingContract }, types: td.types, primaryType: "Permit", message: { owner: message.owner, spender: message.spender, value: BigInt(message.value), nonce: BigInt(message.nonce), deadline: BigInt(message.deadline) }, signature } as never).catch(() => null);
    if (!recovered || recovered.toLowerCase() !== owner) throw new HttpError(422, "permit_signature_invalid", "签名不是 owner 对这份额度请求签的");
    if (!this.d.chain) throw new HttpError(503, "chain_unavailable");
    const chainNonce = (await this.d.chain.nonces(p.tokenAddress as EvmAddress, owner as EvmAddress)).toString();
    if (chainNonce !== p.nonce) throw new HttpError(409, "permit_nonce_stale", "代币 nonce 已变化：重新 GET 取新请求");
    if (await this.d.jobs?.inflightPermit(owner, p.tokenAddress)) throw new HttpError(409, "permit_pending", "该代币已有一笔额度签名在途");
    const ledger = await this.ownerLedgerMandates(owner);
    const onchain = BigInt(await this.onchainAllowance(p.tokenAddress, owner));
    if (p.purpose === "delegation") {
      const t = task!;
      const st = this.stateOf(t);
      const mandates = t.mandateIds.length ? await this.d.db.select().from(verifyMandates).where(inArray(verifyMandates.id, t.mandateIds)) : [];
      const scope = scopeOf(t)!;
      const drafts: LedgerDraft[] = [];
      const stable = findEntry(this.d.registry, scope.inputAssetKey)!;
      if (!this.registeredFor(mandates, "buy") && !mandates.some((m) => !MandatesService.isDelegationSell(m))) drafts.push({ id: "buy", token: stable.tokenAddress.toLowerCase() as EvmAddress, budgetCap: scope.budgetCapRaw });
      for (const s of st.sells) if (s.sellCapRaw && !this.registeredFor(mandates, s.itemId)) drafts.push({ id: s.itemId, token: s.token as EvmAddress, budgetCap: s.sellCapRaw });
      const required = BigInt(requiredAllowance(ledger, drafts, p.tokenAddress as EvmAddress));
      if (onchain >= required) throw new HttpError(409, "permit_not_needed", "链上额度已足够：不需要这次签名");
      // 发放值上限（SEC-08，运营者确认 2026-10-02 修正）：value ≤ permitValue(当前需要量) = 当前需要量 + 0.5%。
      // 发放后需要量因成交等变小、使发放值超出余量 → 拒绝，向导重取一份按当前账本算的请求
      if (BigInt(p.value) > BigInt(permitValue(required.toString()))) throw new HttpError(422, "permit_value_too_high", `the issued value ${p.value} exceeds what is needed now (${required} + 0.5% = ${permitValue(required.toString())}); request a fresh allowance signature`, { valueRaw: p.value, requiredRaw: required.toString(), maxRaw: permitValue(required.toString()) });
    } else if (onchain <= BigInt(p.value)) throw new HttpError(409, "permit_not_needed", "链上额度已不高于收回目标：不需要这次签名");
    // 入队：限频计数、费用预检、permit SUBMITTED、建作业在同一事务里完成（咨询锁串行），并发请求不会一起越过上限
    //（部分唯一索引保证同 (owner, token) 只有一笔在途；任何一步失败整笔回滚，permit 保持 ISSUED）
    const nowDate = this.now();
    const payload: PermitJobPayload = { permitId: p.id, owner: owner as EvmAddress, token: p.tokenAddress as EvmAddress, spender: this.planGuard(), value: p.value, nonce: p.nonce, deadline: p.deadline, signature };
    const job = await this.d.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(${FEE_BUDGET_LOCK_KEY})`);
      const hourAgo = new Date(nowDate.getTime() - 3600_000);
      const dayAgo = new Date(nowDate.getTime() - 86_400_000);
      const perOwner = (await tx.select({ id: verifyPermits.id }).from(verifyPermits).where(and(eq(verifyPermits.ownerAddress, owner), isNotNull(verifyPermits.submittedAt), gte(verifyPermits.submittedAt, hourAgo)))).length;
      if (perOwner >= this.d.cfg.PERMIT_RELAY_PER_OWNER_PER_HOUR) throw new HttpError(429, "permit_relay_limited", `每个钱包每小时最多代付 ${this.d.cfg.PERMIT_RELAY_PER_OWNER_PER_HOUR} 笔额度签名`);
      const global = (await tx.select({ id: verifyPermits.id }).from(verifyPermits).where(and(isNotNull(verifyPermits.submittedAt), gte(verifyPermits.submittedAt, dayAgo)))).length;
      if (global >= this.d.cfg.PERMIT_RELAY_DAILY_MAX) throw new HttpError(429, "permit_relay_limited", `全局每天最多代付 ${this.d.cfg.PERMIT_RELAY_DAILY_MAX} 笔额度签名`);
      const fee = this.d.fees ? await this.d.fees.precheckInTx(tx, { owner, taskId: p.taskId }) : null;
      if (fee) throw new HttpError(409, "fee_budget_exhausted", "the platform's transaction-fee budget has no room to relay this allowance signature now; nothing was sent and you do not need to sign again — the operator has been notified", { scope: fee.scope, usedWei: fee.usedWei, limitWei: fee.limitWei });
      const [u] = await tx.update(verifyPermits).set({ state: "SUBMITTED", signature, submittedAt: nowDate, updatedAt: nowDate }).where(and(eq(verifyPermits.id, p.id), eq(verifyPermits.state, "ISSUED"))).returning();
      if (!u) throw new HttpError(409, "permit_not_issued");
      const j = await this.d.jobs!.createPermitJob({ taskId: p.taskId, payload }, tx);
      await tx.update(verifyPermits).set({ jobId: j.id }).where(eq(verifyPermits.id, p.id));
      return j;
    }).catch(async (err: unknown) => {
      if (err instanceof HttpError && err.code === "fee_budget_exhausted") await this.d.fees?.alertOperator("fee_budget_exhausted", `permit relay for owner ${owner} (task ${p.taskId ?? "-"}) refused: fee budget ${(err.details as { scope?: string } | undefined)?.scope ?? "?"} has no room`);
      throw err;
    });
    if (task) await appendTimeline(this.d.db, task.id, { at: nowDate.toISOString(), type: "permit_submitted", ref: p.id, note: `allowance signature for ${p.tokenAddress} submitted; the platform executor relays it on-chain (owner sends no transaction)`, data: { permitId: p.id, jobId: job.id, token: p.tokenAddress, value: p.value } }, actorOf(callerId));
    return { permitId: p.id, jobId: job.id, state: "SUBMITTED" };
  }

  /** permit 作业结果（ExecutionJobs 回调） */
  async onPermitResult(permitId: string, ok: boolean, info: { txHash: string | null; allowanceAfter: string | null; code: string | null }): Promise<void> {
    const nowDate = this.now();
    const [p] = await this.d.db.update(verifyPermits).set({ state: ok ? "CONFIRMED" : "FAILED", txHash: info.txHash, allowanceAfter: info.allowanceAfter, updatedAt: nowDate }).where(and(eq(verifyPermits.id, permitId), inArray(verifyPermits.state, ["SUBMITTED", "ISSUED"]))).returning();
    if (!p || !p.taskId) return;
    await appendTimeline(this.d.db, p.taskId, { at: nowDate.toISOString(), type: ok ? "permit_confirmed" : "permit_failed", ref: p.id, note: ok ? `allowance for ${p.tokenAddress} set on-chain (${info.txHash})` : `allowance signature failed: ${info.code ?? "unknown"}`, data: { permitId: p.id, token: p.tokenAddress, txHash: info.txHash, allowanceAfter: info.allowanceAfter } }, "executor:hosted");
    const task = await this.d.tasks.byId(p.taskId);
    if (!task) return;
    if (!ok && info.code && FEE_OPERATOR_CODES.has(info.code)) await this.d.tasks.deps.notifier.emit(notificationPayload("task.execution_failed", task.id, Math.floor(nowDate.getTime() / 1000), `allowance signature not relayed (${info.code}): the platform is handling it; nothing for you to sign`, `/agent/tasks/${task.id}`, nowDate.toISOString()), task.ownerAddress);
    else if (!ok) await this.d.tasks.deps.notifier.emit(notificationPayload("task.needs_owner", task.id, Math.floor(nowDate.getTime() / 1000), `allowance signature failed (${info.code ?? "unknown"}): sign again`, `/agent/tasks/${task.id}`, nowDate.toISOString()), task.ownerAddress);
    await this.refreshDelegation(task.id).catch((err) => log.warn("委托状态刷新失败", { taskId: task.id, error: err instanceof Error ? err.message : String(err) }));
  }

  /** buyReady 首次为真 → ACTIVE（开第一轮）；complete 首次为真 → task.delegation_completed（恰一次） */
  async refreshDelegation(taskId: string): Promise<TaskRow | null> {
    const row = await this.d.tasks.byId(taskId);
    if (!row || !isDelegationTask(row)) return row;
    let c: DelegationChecklist;
    try {
      c = await this.checklistFor(row, { issue: false });
    } catch (err) {
      log.warn("委托清单计算失败（链不可用？）", { taskId, error: err instanceof Error ? err.message : String(err) });
      return row;
    }
    let cur = (await this.d.tasks.byId(taskId)) ?? row;
    const st = this.stateOf(cur);
    const nowIso = this.now().toISOString();
    let changed = false;
    if (c.buyReady && !st.buyReadyAt) {
      st.buyReadyAt = nowIso;
      changed = true;
    }
    let completedNow = false;
    if (c.complete && !st.completeAt) {
      st.completeAt = nowIso;
      changed = true;
      completedNow = true;
    }
    if (changed) await this.saveState(taskId, st);
    if (c.buyReady && cur.status === "AWAITING_AUTHORIZATION") {
      cur = await this.d.tasks.setStatus(cur, "ACTIVE", "delegation: buy authorization and allowance are ready", {}, "system");
      cur = await this.d.tasks.evaluateTask(cur, { issue: false });
      // 第一轮（authorized）：托管 Agent 接班
      if (cur.agentMode === "hosted") await this.d.agent?.onAuthorized(taskId).catch((err) => log.warn("onAuthorized 失败", { taskId, error: err instanceof Error ? err.message : String(err) }));
    }
    if (completedNow) {
      await appendTimeline(this.d.db, taskId, { at: nowIso, type: "delegation_completed", note: `delegation complete: ${c.counts.signaturesDone} signature(s), ${c.counts.userTransactions} user transaction(s)`, data: { signatures: c.counts.signaturesDone, userTransactions: c.counts.userTransactions } }, "system");
      await this.d.tasks.deps.notifier.emit(notificationPayload("task.delegation_completed", taskId, 1, `delegation complete: ${c.counts.signaturesDone} signatures, ${c.counts.userTransactions} transactions from your wallet`, `/agent/tasks/${taskId}`, nowIso), cur.ownerAddress);
    }
    return (await this.d.tasks.byId(taskId)) ?? cur;
  }

  /* ================= owner 维度额度 ================= */

  async ownerAllowances(callerId: string, owner: string) {
    const o = owner.toLowerCase();
    if (!callerActsFor(callerId, o)) throw new HttpError(403, "owner_forbidden", "只有该钱包本人能看自己的额度");
    const ledger = await this.ownerLedgerMandates(o);
    const tokens = new Set([...this.d.domains.status().map((x) => x.token), ...ledger.map((m) => m.token.toLowerCase())]);
    const out = [];
    for (const token of tokens) {
      const e = this.d.registry.entries.find((x) => x.tokenAddress.toLowerCase() === token);
      if (!e) continue;
      const onchainRaw = await this.onchainAllowance(token, o);
      const requiredRaw = requiredAllowance(ledger, [], token as EvmAddress);
      out.push({ token, assetKey: e.assetKey, symbol: e.displaySymbol, decimals: e.tokenDecimals, onchainRaw, requiredRaw, excessRaw: (BigInt(onchainRaw) > BigInt(requiredRaw) ? BigInt(onchainRaw) - BigInt(requiredRaw) : 0n).toString(), reclaimSuggested: reclaimSuggested(onchainRaw, requiredRaw), pendingPermit: !!(await this.d.jobs?.inflightPermit(o, token)), permitSupported: this.d.domains.supported(token) });
    }
    return { owner: o, spender: this.planGuard(), allowances: out, note: "PlanGuard can only use an allowance inside mandates you signed that are still valid; you can also send approve(PlanGuard, 0) yourself." };
  }

  async reclaim(callerId: string, owner: string, body: Record<string, unknown>) {
    const o = owner.toLowerCase();
    if (!callerActsFor(callerId, o)) throw new HttpError(403, "owner_forbidden");
    const token = typeof body["token"] === "string" ? body["token"].toLowerCase() : "";
    if (!this.d.registry.entries.some((e) => e.tokenAddress.toLowerCase() === token)) throw new HttpError(400, "invalid_request", "token 必须是登记表代币", [{ field: "token", code: "unknown_token" }]);
    const required = requiredAllowance(await this.ownerLedgerMandates(o), [], token as EvmAddress);
    const value = reclaimValue(required);
    const onchain = await this.onchainAllowance(token, o);
    if (BigInt(onchain) <= BigInt(value)) throw new HttpError(409, "permit_not_needed", "链上额度已不高于需要量：没有可收回的");
    const p = await this.issuePermit({ taskId: null, itemId: null, owner: o, token, value, purpose: "reclaim" });
    return { permitRequestId: p.id, token, value, typedData: p.typedDataJson, valueRaw: value, requiredRaw: required, onchainRaw: onchain, note: "Sign this to lower PlanGuard's allowance to what your remaining mandates still need. It is a signature, not a transaction." };
  }

  /* ================= 接管切换 ================= */

  async handover(callerId: string, taskId: string, body: Record<string, unknown>): Promise<TaskRow> {
    const row = await this.d.tasks.requireTask(callerId, taskId, "owner_write");
    if (scopeOf(row)?.issuance !== "agent") throw new HttpError(409, "issuance_not_agent", "只有 scope.issuance=agent 的任务可以切换 Agent / 执行方式");
    const agent = body["agent"];
    const executor = body["executor"];
    const set: Partial<typeof verifyTasks.$inferInsert> = {};
    if (agent !== undefined) {
      if (agent !== null && agent !== "hosted" && agent !== "byo") throw new HttpError(400, "invalid_request", "agent 必须是 hosted | byo | null");
      if (agent === "hosted" && !this.d.cfg.v7.hostedAgent) throw new HttpError(503, "hosted_disabled");
      if (agent === "hosted" && row.mode === "LIVE" && !this.allowlisted(row.ownerAddress)) throw new HttpError(403, "hosted_not_allowed");
      set.agentMode = agent as string | null;
    }
    if (executor !== undefined) {
      if (!(EXECUTOR_MODES as readonly unknown[]).includes(executor)) throw new HttpError(400, "invalid_request", "executor 必须是 hosted | agent_wallet | browser");
      if (row.mode !== "LIVE") throw new HttpError(400, "invalid_request", "SIMULATION 任务不执行");
      if (executor === "hosted" && !this.d.cfg.v7.hostedExecutor) throw new HttpError(503, "hosted_disabled");
      if (executor === "hosted" && !this.allowlisted(row.ownerAddress)) throw new HttpError(403, "hosted_not_allowed");
      if (executor === "hosted" && row.goalJson && (row.goalJson as { recipientAddress?: string }).recipientAddress?.toLowerCase() !== row.ownerAddress) throw new HttpError(400, "recipient_must_be_owner");
      if (this.d.jobs && executor !== row.executorMode) {
        const inflight = await this.d.db.select({ id: verifyExecutionJobs.id }).from(verifyExecutionJobs).where(and(eq(verifyExecutionJobs.taskId, taskId), eq(verifyExecutionJobs.kind, "execute_step"), inArray(verifyExecutionJobs.state, ["SENDING", "SENT"]))).limit(1);
        if (inflight.length) throw new HttpError(409, "execution_in_flight", "有一笔交易正在广播或等待上链：等它结算后再切换");
        await this.d.jobs.cancelUnsent({ taskId }, "handover");
      }
      set.executorMode = executor as string;
    }
    if (Object.keys(set).length === 0) return row;
    const [u] = await this.d.db.update(verifyTasks).set({ ...set, updatedAt: this.now() }).where(eq(verifyTasks.id, taskId)).returning();
    if (set.agentMode === "hosted" && row.agentMode !== "hosted") await this.d.agent?.onAssigned(taskId).catch((err) => log.warn("onAssigned 失败", { taskId, error: err instanceof Error ? err.message : String(err) }));
    await appendTimeline(this.d.db, taskId, { at: this.now().toISOString(), type: "handover", note: `handover: agent ${String(set.agentMode ?? row.agentMode ?? "none")}, executor ${String(set.executorMode ?? row.executorMode ?? "none")}; the signed scope is unchanged (scopeHash ${row.scopeHash})`, data: { agentMode: set.agentMode ?? row.agentMode ?? null, executorMode: set.executorMode ?? row.executorMode ?? null } }, actorOf(callerId));
    return u ?? row;
  }

  /* ================= 持仓 / 完成规则 ================= */

  async positions(row: TaskRow): Promise<TaskPosition[]> {
    return taskPositions({ db: this.d.db, registry: this.d.registry, chain: this.d.chain, dustRaw: BigInt(this.d.cfg.POSITION_DUST_RAW) }, row);
  }

  async agentTaskComplete(row: TaskRow): Promise<boolean> {
    const mandates = row.mandateIds.length ? await this.d.db.select().from(verifyMandates).where(inArray(verifyMandates.id, row.mandateIds)) : [];
    const buy = this.registeredFor(mandates, "buy") ?? mandates.find((m) => !MandatesService.isDelegationSell(m)) ?? null;
    if (!buy || buy.state !== "COMPLETED") return false;
    if (!scopeOf(row)?.allowSell) return true;
    const dust = BigInt(this.d.cfg.POSITION_DUST_RAW);
    const pos = await taskPositions({ db: this.d.db, registry: this.d.registry, chain: null, dustRaw: dust }, row);
    return pos.every((p) => BigInt(p.netRaw) < dust);
  }

  /* ================= 暂停 / 视图 / 运行态 ================= */

  async onPause(row: TaskRow): Promise<string | null> {
    if (row.executorMode !== "hosted" || !this.d.jobs) return null;
    const r = await this.d.jobs.cancelUnsent({ taskId: row.id }, "task_paused");
    return `Hosted execution: pause takes effect before sending (${r.cancelled} unsent job(s) cancelled); a transaction already broadcast (${r.inflight}) settles on-chain.`;
  }

  async executorStatus(row: TaskRow): Promise<ExecutorStatus> {
    const mode = (row.executorMode as ExecutorMode | null) ?? null;
    if (mode !== "hosted") return { mode, state: mode ? "ready" : "disabled", address: null, lastJobAt: null };
    if (!this.d.cfg.v7.hostedExecutor) return { mode, state: "disabled", address: null, lastJobAt: null };
    const st = (await this.d.db.select().from(verifyExecutorStatus).orderBy(desc(verifyExecutorStatus.lastHeartbeatAt)).limit(1))[0];
    const lastJob = (await this.d.db.select({ at: verifyExecutionJobs.updatedAt, state: verifyExecutionJobs.state }).from(verifyExecutionJobs).where(eq(verifyExecutionJobs.taskId, row.id)).orderBy(desc(verifyExecutionJobs.updatedAt)).limit(1))[0];
    const online = !!st?.lastHeartbeatAt && this.now().getTime() - st.lastHeartbeatAt.getTime() < 90_000;
    const gasLow = !!st && (this.d.jobs?.gasLow(st.executor) ?? false);
    const busy = !!lastJob && ["CLAIMED", "SENDING", "SENT"].includes(lastJob.state);
    const state: ExecutorStatus["state"] = !online ? "offline" : row.status === "PAUSED" ? "paused" : gasLow ? "gas_low" : busy ? "busy" : "ready";
    return { mode, state, address: (st?.executor as EvmAddress | undefined) ?? null, lastJobAt: lastJob?.at.toISOString() ?? null };
  }

  /** needsOwner（§2.1 列出的代码，S-07：不误报） */
  async needs(row: TaskRow): Promise<{ owner: NeedsOwnerItem[]; operator: NeedsOperatorCode[]; executor: ExecutorStatus }> {
    const owner: NeedsOwnerItem[] = [];
    const operator: NeedsOperatorCode[] = [];
    const item = (code: NeedsOwnerItem["code"], blocking: boolean, kind: NeedsOwnerItem["action"]["kind"], itemId?: string) => owner.push({ code, blocking, text: NEEDS_OWNER_TEXT[code], action: { kind, ...(itemId ? { itemId } : {}) } });
    const st = isDelegationTask(row) ? this.stateOf(row) : null;
    if (st && row.mode === "LIVE" && !st.buyReadyAt && !TASK_TERMINAL_STATUSES.has(row.status as TaskStatus)) item("delegation_incomplete", true, "sign_delegation");
    if (row.status === "REVOKE_PENDING") item("revoke_pending", true, "confirm_revoke");
    if (row.pausedBy === "agent" && row.status === "PAUSED") item("agent_ended", true, "resume_or_cancel");
    const jobs = this.d.jobs ? await this.d.jobs.forTask(row.id) : [];
    const lastStepJob = [...jobs].reverse().find((j) => j.kind === "execute_step");
    const cls = (lastStepJob?.resultJson as { cls?: string } | null)?.cls ?? null;
    if (lastStepJob && lastStepJob.state === "FAILED" && (cls === "allowance" || lastStepJob.errorCode === "allowance_low")) item("allowance_low", true, "sign_permit");
    if (lastStepJob && lastStepJob.state === "FAILED" && (cls === "balance" || lastStepJob.errorCode === "balance_low")) item("balance_low", true, "top_up");
    if (lastStepJob && cls === "paused") operator.push("contract_paused");
    // 费用护栏挡下的作业：交易没有发出，是平台侧的事（不让 owner 去签名）
    if (lastStepJob && lastStepJob.state === "FAILED" && lastStepJob.errorCode && FEE_OPERATOR_CODES.has(lastStepJob.errorCode)) operator.push(lastStepJob.errorCode as NeedsOperatorCode);
    const lastPermit = (await this.d.db.select().from(verifyPermits).where(and(eq(verifyPermits.taskId, row.id), ne(verifyPermits.state, "ISSUED"), ne(verifyPermits.state, "SUPERSEDED"))).orderBy(desc(verifyPermits.createdAt)).limit(1))[0];
    const lastPermitJob = lastPermit?.state === "FAILED" ? jobs.find((j) => j.id === lastPermit.jobId) : undefined;
    if (lastPermit?.state === "FAILED" && lastPermitJob?.errorCode && FEE_OPERATOR_CODES.has(lastPermitJob.errorCode)) operator.push(lastPermitJob.errorCode as NeedsOperatorCode);
    else if (lastPermit?.state === "FAILED") item("permit_failed", true, "sign_permit", permitItemId(lastPermit.tokenAddress));
    if (["COMPLETED", "EXPIRED"].includes(row.status) || (row.deadline.getTime() < this.now().getTime() && !TASK_TERMINAL_STATUSES.has(row.status as TaskStatus))) item("scope_exhausted", false, "create_new_task");
    if (this.d.ops.recentAlerts(row.id).some((a) => !FEE_OPERATOR_CODES.has(a.code))) operator.push("integrity_alert");
    const executor = await this.executorStatus(row);
    if (row.executorMode === "hosted" && this.d.cfg.v7.hostedExecutor) {
      if (executor.state === "offline") operator.push("executor_offline");
      if (executor.state === "gas_low") operator.push("executor_gas_low");
    }
    return { owner, operator: [...new Set(operator)], executor };
  }

  async view(row: TaskRow): Promise<Record<string, unknown>> {
    if (!isDelegationTask(row) && !row.agentMode && !row.executorMode) return {};
    const n = await this.needs(row);
    const st = isDelegationTask(row) ? this.stateOf(row) : null;
    return {
      runtime: await this.runtimeFrom(row, n),
      delegation: st ? { ...(await this.countsFor(row)), buyReady: !!st.buyReadyAt, complete: !!st.completeAt, buyReadyAt: st.buyReadyAt, completeAt: st.completeAt, sells: st.sells.map((s) => ({ itemId: s.itemId, assetKey: s.assetKey, sellCapRaw: s.sellCapRaw, error: s.error })), checklist: `/v1/tasks/${row.id}/delegation` } : null,
      steps: { planned: row.stepsPlanned, confirmed: row.stepsConfirmed, lastConfirmedAt: row.lastConfirmedStepAt?.toISOString() ?? null, buy: { planned: row.stepsPlanned, confirmed: row.stepsConfirmed }, sell: { confirmed: row.sellStepsConfirmed } },
    };
  }

  /* ================= 意图（X7 卖出分支 + 委托 / 额度检查） ================= */

  async intentScope(row: TaskRow, b: { kind: "buy" | "sell"; assetKey: string; outputAssetKey: string; amountInRaw: string }, buyMandate: MandateRow | null): Promise<{ reasons: Reason[]; mandate: MandateRow | null; detail: Record<string, unknown> }> {
    const reasons: Reason[] = [];
    const scope = scopeOf(row) as TaskScope;
    const amount = BigInt(b.amountInRaw);
    const block = (code: Reason["code"], detail: Record<string, string | number | boolean | null>): Reason => ({ code, severity: "block", evidenceIds: [], detail });
    const oos = (field: string, note: string) => block("INTENT_OUT_OF_SCOPE", { field, note });
    const delegation = isDelegationTask(row);
    const detail: Record<string, unknown> = {};
    let mandate: MandateRow | null = buyMandate;
    if (b.kind === "sell") {
      // 卖出独立分支：拿股票数量比稳定币上限会全部误判，所以不走买入的范围检查
      mandate = null;
      if (!scope.allowSell) reasons.push(oos("kind", "scope.allowSell is false"));
      if (!scope.outputAssetKeys.includes(b.assetKey)) reasons.push(oos("assetKey", `not in scope.outputAssetKeys [${scope.outputAssetKeys.join(", ")}]`));
      if (b.outputAssetKey && b.outputAssetKey !== scope.inputAssetKey) reasons.push(oos("outputAssetKey", "a sell converts back to the task's funding asset only"));
      if (Date.parse(scope.deadline) <= this.now().getTime()) reasons.push(oos("deadline", "scope.deadline passed"));
      if (reasons.length) return { reasons, mandate, detail };
      const st = this.stateOf(row);
      const item = st.sells.find((s) => s.assetKey === b.assetKey);
      if (!delegation || !item) {
        reasons.push(block("SELL_MANDATE_REQUIRED", { note: "this task has no sell draft (created before v7 delegation): create a new task to sell" }));
        return { reasons, mandate, detail };
      }
      mandate = await this.sellMandate(row, b.assetKey);
      if (!mandate) {
        reasons.push(block("SELL_NOT_DELEGATED", { assetKey: b.assetKey, note: "the sell authorization for this asset is not signed" }));
        return { reasons, mandate, detail };
      }
      if (mandate.state !== "ACTIVE") reasons.push(oos("mandate", `sell authorization is ${mandate.state}`));
      if (!this.sellReady(row, b.assetKey, item.token)) reasons.push(block("DELEGATION_INCOMPLETE", { itemId: permitItemId(item.token), note: "the allowance signature for this stock is not confirmed yet" }));
      const perStep = BigInt((mandate.mandateJson as MandateJson).mandate.perStepCap);
      const remaining = BigInt(mandate.budgetCap) - BigInt(mandate.spent);
      if (amount > perStep) reasons.push(oos("amountInRaw", `exceeds the sell authorization's per-step cap ${perStep}`));
      if (amount > remaining) reasons.push(oos("amountInRaw", `exceeds the sell authorization's remaining ${remaining}`));
      if (mandate.stepsDone >= mandate.maxSteps) reasons.push(oos("maxSteps", `${mandate.stepsDone}/${mandate.maxSteps} sell steps done`));
      // 服务上限（D-092 运营者确认 2026-10-02 简化）= 链上实际余额：可卖出全部持仓（已有 + 本任务买入），不再限于本任务净持仓
      const pos = (await this.positions(row)).find((p) => p.assetKey === b.assetKey);
      detail["netRaw"] = pos?.netRaw ?? "0";
      const bal = pos && pos.onchainRaw !== null ? BigInt(pos.onchainRaw) : null;
      detail["sellableRaw"] = bal === null ? null : bal.toString();
      if (bal === null) reasons.push(block("SELL_EXCEEDS_TASK_POSITION", { amountInRaw: b.amountInRaw, note: "balance_unavailable: your on-chain balance of this stock could not be read, so the sell cannot be checked against it; retry shortly" }));
      else if (amount > bal) reasons.push(block("BALANCE_INSUFFICIENT", { side: "sell", balanceRaw: bal.toString(), sellableRaw: bal.toString(), amountInRaw: b.amountInRaw, note: "a sell can use at most your on-chain balance of this stock" }));
    } else if (delegation && !this.buyReady(row)) {
      reasons.push(block("DELEGATION_INCOMPLETE", { itemId: "buy", note: "the buy authorization or its allowance signature is not confirmed yet" }));
    }
    // 实时额度 / 余额（buyReady / sellReady 是委托事实，不是额度保证）
    if (mandate && this.d.chain && reasons.length === 0) {
      const token = (mandate.mandateJson as MandateJson).mandate.inputToken as EvmAddress;
      try {
        const allowance = await this.d.chain.allowance(token, row.ownerAddress as EvmAddress, this.planGuard());
        const balance = await this.d.chain.balanceOf(token, row.ownerAddress as EvmAddress);
        detail["allowanceRaw"] = allowance.toString();
        if (allowance < amount) reasons.push(block("ALLOWANCE_INSUFFICIENT", { allowanceRaw: allowance.toString(), amountInRaw: b.amountInRaw, note: "PlanGuard's on-chain allowance is below this step: sign a new allowance (GET /v1/tasks/:id/delegation)" }));
        if (balance < amount) reasons.push(block("BALANCE_INSUFFICIENT", { balanceRaw: balance.toString(), amountInRaw: b.amountInRaw }));
      } catch (err) {
        log.warn("意图实时额度读取失败（不阻塞，执行者预检兜底）", { taskId: row.id, error: err instanceof Error ? err.message.slice(0, 160) : String(err) });
      }
    }
    return { reasons, mandate, detail };
  }

  async enqueueStep(row: TaskRow, mandate: MandateRow, step: StepRow): Promise<string | null> {
    if (row.executorMode !== "hosted" || !this.d.jobs || !this.d.cfg.v7.hostedExecutor) return null;
    return (await this.d.jobs.createStepJob(mandate, step)).id;
  }

  async cancelStepJobs(stepIds: string[], code: string): Promise<void> {
    if (!this.d.jobs || stepIds.length === 0) return;
    await this.d.jobs.cancelUnsent({ stepIds }, code);
  }

  /** 视图用的签名计数（读链上额度；读不到就不给 counts，页面回落到 GET /delegation） */
  private async countsFor(row: TaskRow): Promise<{ counts?: DelegationChecklist["counts"] }> {
    try {
      return { counts: (await this.checklistFor(row, { issue: false })).counts };
    } catch {
      return {};
    }
  }

  /** 完整运行态（Lane X 的 executor / needs + Lane A 的 presence / agent needs） */
  async runtime(row: TaskRow): Promise<TaskRuntime> {
    return this.runtimeFrom(row, await this.needs(row));
  }
  private async runtimeFrom(row: TaskRow, n: { owner: NeedsOwnerItem[]; operator: NeedsOperatorCode[]; executor: ExecutorStatus }): Promise<TaskRuntime> {
    return composeTaskRuntime(this.d.db, row, n, { ...(this.d.agent ? { agentNeedsOperator: (id: string) => this.d.agent!.needsOperatorFor(id) } : {}), jobOf: async (intentId) => (await this.jobForIntent(intentId)) as { state: ExecutionJobState; errorCode: string | null } | null });
  }
  async jobForIntent(intentId: string): Promise<{ state: string; errorCode: string | null } | null> {
    const it = (await this.d.db.select({ jobId: verifyTaskIntents.jobId }).from(verifyTaskIntents).where(eq(verifyTaskIntents.id, intentId)).limit(1))[0];
    if (!it?.jobId || !this.d.jobs) return null;
    const j = await this.d.jobs.byId(it.jobId);
    return j ? { state: j.state, errorCode: j.errorCode } : null;
  }
  /** SIMULATION 托管任务建好后立即开 assigned 轮次（Lane A） */
  async afterCreate(row: TaskRow): Promise<void> {
    if (row.agentMode === "hosted" && row.mode === "SIMULATION") await this.d.agent?.onAssigned(row.id).catch((err) => log.warn("onAssigned 失败", { taskId: row.id, error: err instanceof Error ? err.message : String(err) }));
  }
  /** Lane A 决策上下文的数据提供者 */
  agentProviders() {
    return {
      positions: async (taskId: string) => {
        const row = await this.d.tasks.byId(taskId);
        return row ? ((await this.positions(row)) as unknown as Array<Record<string, unknown>>) : [];
      },
      budgetExtras: async (taskId: string) => {
        const row = await this.d.tasks.byId(taskId);
        if (!row || !this.d.chain) return {};
        const scope = scopeOf(row);
        const st = this.stateOf(row);
        const allowanceRaw: Record<string, string> = {};
        const tokens = [findEntry(this.d.registry, scope?.inputAssetKey ?? "")?.tokenAddress, ...st.sells.map((x) => x.token)].filter((t): t is string => !!t);
        for (const t of tokens) allowanceRaw[t.toLowerCase()] = await this.onchainAllowance(t, row.ownerAddress).catch(() => "unknown");
        const sellReady: Record<string, boolean> = {};
        for (const sItem of st.sells) sellReady[sItem.assetKey] = !!(await this.sellMandate(row, sItem.assetKey)) && this.sellReady(row, sItem.assetKey, sItem.token);
        return { allowanceRaw, sellReady };
      },
      jobForIntent: (intentId: string) => this.jobForIntent(intentId),
      sellCapRaw: async (taskId: string, assetKey: string) => {
        const row = await this.d.tasks.byId(taskId);
        if (!row) return null;
        const m = await this.sellMandate(row, assetKey);
        return m ? (m.mandateJson as MandateJson).mandate.perStepCap : null;
      },
    };
  }

  /** 任务的卖出授权（按资产；ACTIVE / PAUSED） */
  async sellMandate(row: TaskRow, assetKey: string): Promise<MandateRow | null> {
    if (!row.mandateIds.length) return null;
    const mandates = await this.d.db.select().from(verifyMandates).where(inArray(verifyMandates.id, row.mandateIds));
    return this.registeredFor(mandates.filter((m) => m.state === "ACTIVE" || m.state === "PAUSED"), mandateItemId("sell", assetKey)) ?? null;
  }
  /** 卖出就绪（sellReady[asset]）：卖出授权 ACTIVE ∧ 该股票 permit 项 confirmed / not_needed（latched） */
  sellReady(row: TaskRow, assetKey: string, token: string): boolean {
    const st = this.stateOf(row);
    const l = st.latched[permitItemId(token)];
    return l === "confirmed" || l === "not_needed";
  }
  buyReady(row: TaskRow): boolean {
    return !!this.stateOf(row).buyReadyAt;
  }
}

