/**
 * 任务运行态（开发计划 §2.1 TaskRuntime）的服务侧合成。Lane X 与 Lane A 共用本文件：
 *   - Lane A（本节）：Agent 接管状态 presence + Agent 相关的 needsOwner（agent_ended）/ needsOperator（model_unavailable / agent_budget_exhausted）
 *   - Lane X：executor、委托 / 额度相关的 needsOwner、执行身份相关的 needsOperator，以及最终的 TaskRuntime 合成
 * 两边的函数各自独立，不互相改写。
 */
import { desc, eq } from "drizzle-orm";
import type { Db } from "@chaconne/db";
import { verifyAgentRunSteps, verifyAgentRuns, verifyTaskIntents } from "@chaconne/db";
import type { AgentMode, AgentPresence, AgentTurn, Blocker, EvmAddress, ExecutorMode, ExecutorStatus, NeedsOperatorCode, NeedsOwnerItem, Reason, TaskBrief, TaskRuntime } from "@chaconne/core/verify";
import { activityText, derivePresence, type PresenceJob, type PresenceRun } from "@chaconne/core/verify/agent/index";
import type { MandateRow, StepRow } from "../mandates/service";
import type { TaskRow } from "./service";

/* ======================= Lane A：Agent presence ======================= */

/** Agent 报 ended 后的内部暂停 → 阻塞型 needsOwner（恢复让它继续，或取消并收回额度） */
export function agentNeedsOwner(row: Pick<TaskRow, "status" | "pausedBy">): NeedsOwnerItem[] {
  if (row.status === "PAUSED" && row.pausedBy === "agent")
    return [{ code: "agent_ended", blocking: true, text: { zh: "Agent 认为本任务已完成或不值得继续，已暂停。你可以恢复让它继续，或取消并收回额度。", en: "The agent considers this task done or not worth continuing and paused it. Resume to let it continue, or cancel and reclaim the allowance." }, action: { kind: "resume_or_cancel" } }];
  return [];
}

/**
 * 读库后调用 core derivePresence：
 *  - run = 该任务最近一条轮次（活跃时 currentActivity = 最近一次工具调用的人话；lastDecisionAt = 最近一条带动作轮次的结束时刻）
 *  - intent / job = 最近一条意图与它的执行作业（作业状态由 Lane X 的 jobOf 提供；缺省 null）
 *  - needs = Lane X 的 needsOwner / needsOperator 与 Lane A 的合并结果（调用方传入）
 */
export async function agentPresenceFor(db: Db, row: TaskRow, needs: { owner: NeedsOwnerItem[]; operator: NeedsOperatorCode[] }, jobOf?: (intentId: string) => Promise<PresenceJob | null>, nowMs: number = Date.now()): Promise<AgentPresence> {
  const agentMode: "hosted" | "byo" | null = row.agentMode === "hosted" || row.agentMode === "byo" ? row.agentMode : null;
  const brief = (row.briefJson as TaskBrief | null) ?? null;
  const turn = (row.agentTurnJson as AgentTurn | null) ?? null;
  const base = { agentMode, status: row.status, pausedBy: row.pausedBy, nextAgentCheckAt: row.nextAgentCheckAt?.toISOString() ?? null, blockers: ((row.blockersJson as Blocker[] | null) ?? []).map((b) => b.code), lastResponseAt: brief?.agent?.lastResponseAt ?? turn?.respondedAt ?? null };
  if (agentMode !== "hosted") return derivePresence(base, null, null, null, needs, nowMs);
  const latest = (await db.select().from(verifyAgentRuns).where(eq(verifyAgentRuns.taskId, row.id)).orderBy(desc(verifyAgentRuns.updatedAt)).limit(1))[0];
  const decided = (await db.select({ endedAt: verifyAgentRuns.endedAt, runHash: verifyAgentRuns.runHash }).from(verifyAgentRuns).where(eq(verifyAgentRuns.taskId, row.id)).orderBy(desc(verifyAgentRuns.endedAt)).limit(5)).find((r) => r.runHash && r.endedAt);
  let run: PresenceRun | null = null;
  if (latest) {
    const step = (await db.select({ name: verifyAgentRunSteps.name, kind: verifyAgentRunSteps.kind }).from(verifyAgentRunSteps).where(eq(verifyAgentRunSteps.runId, latest.id)).orderBy(desc(verifyAgentRunSteps.id)).limit(1))[0];
    // 租约已过期的「活跃」轮次不算在工作（complete 没落库的轮次会卡在 RUNNING，sweeper 收尾前也别显示「正在工作」）
    const expired = (latest.state === "CLAIMED" || latest.state === "RUNNING") && (!latest.leaseUntil || latest.leaseUntil.getTime() <= nowMs);
    const answeredAt = turn && turn.state !== "awaiting_agent" && turn.state !== "no_response" ? turn.respondedAt : null;
    run = { state: expired ? "INCOMPLETE" : (latest.state as PresenceRun["state"]), currentActivity: expired ? null : step?.kind === "tool" ? activityText(step.name) : step ? "thinking" : null, lastDecisionAt: decided?.endedAt?.toISOString() ?? answeredAt ?? null };
  }
  const intent = (await db.select({ id: verifyTaskIntents.id, status: verifyTaskIntents.status }).from(verifyTaskIntents).where(eq(verifyTaskIntents.taskId, row.id)).orderBy(desc(verifyTaskIntents.createdAt)).limit(1))[0];
  const job = intent && jobOf ? await jobOf(intent.id) : null;
  return derivePresence(base, run, intent ? { status: intent.status } : null, job, needs, nowMs);
}

/**
 * Lane A 先给出的运行态（Lane X 合并前的过渡装配，供活动流 `runtime` 字段）：presence 与 Agent 相关的 needs 是真的；
 * executor 段在 Lane X 接入前只给模式与 disabled / offline，不伪装在线。Lane X 接入后由它的合成函数替换。
 */
export async function agentOnlyTaskRuntime(db: Db, row: TaskRow, opts: { hostedExecutorEnabled: boolean; needsOperator?: (taskId: string) => Promise<NeedsOperatorCode[]> }): Promise<TaskRuntime> {
  const needsOwner = agentNeedsOwner(row);
  const needsOperator = row.agentMode === "hosted" && opts.needsOperator ? await opts.needsOperator(row.id) : [];
  const executorMode = row.executorMode === "hosted" || row.executorMode === "agent_wallet" || row.executorMode === "browser" ? row.executorMode : null;
  return {
    agentMode: row.agentMode === "hosted" || row.agentMode === "byo" ? row.agentMode : null,
    executorMode,
    presence: await agentPresenceFor(db, row, { owner: needsOwner, operator: needsOperator }),
    executor: { mode: executorMode, state: executorMode === "hosted" ? (opts.hostedExecutorEnabled ? "offline" : "disabled") : "disabled", address: null, lastJobAt: null },
    needsOwner,
    needsOperator,
  };
}

/* ======================= Lane X：委托 / 执行钩子与运行态合成 ======================= */

export interface V7CreateInput {
  callerId: string;
  body: Record<string, unknown>;
  taskId: string;
  owner: EvmAddress;
  recipient: EvmAddress;
  mode: "LIVE" | "SIMULATION";
  goalMode: boolean;
  scope: { inputAssetKey: string; outputAssetKeys: string[]; budgetCapRaw: string; perStepCapRaw: string; maxSteps: number; deadline: string; allowSell: boolean; issuance: string };
  scopeHash: string;
  goal: { policyId: string; policyVersion: string; maxSlippageBps: number; maxPriceImpactBps: number | null; maxReferenceDeviationBps?: number | null };
  nowDate: Date;
}
export interface V7CreateResult {
  agentMode: AgentMode | null;
  executorMode: ExecutorMode | null;
  delegationJson: Record<string, unknown> | null;
}

/** TasksService 调用的 v7 钩子（Lane X 实现） */
export interface TasksV7Hooks {
  /** POST /v1/tasks：agent / executor 模式、准入（白名单 / 观察模式日次数）、recipient == owner、卖出草案 */
  prepareCreate(a: V7CreateInput): Promise<V7CreateResult | null>;
  /** authorize(itemId = sell:<assetKey>) */
  authorizeSell(callerId: string, row: TaskRow, itemId: string, body: Record<string, unknown>): Promise<{ row: TaskRow; mandate: Record<string, unknown> }>;
  /** 授权 / permit 确认之后：buyReady 首次为真 → ACTIVE；complete 首次为真 → task.delegation_completed */
  refreshDelegation(taskId: string): Promise<TaskRow | null>;
  /** 登记授权时记下的区块号（链上回填从这里扫） */
  fromBlock(): Promise<string | null>;
  /** 暂停：取消从未广播的作业；返回给 owner 的说明（托管执行任务） */
  onPause(row: TaskRow): Promise<string | null>;
  /** GET /v1/tasks/:id 的 v7 字段：runtime / delegation 摘要 / positions 摘要 / steps */
  view(row: TaskRow): Promise<Record<string, unknown>>;
  /** 任务行写入之后（SIMULATION 托管任务立即开 assigned 轮次） */
  afterCreate?(row: TaskRow): Promise<void>;
  /** issuance=agent 的委托任务是否满足完成条件：买入授权 COMPLETED ∧（不允许卖出 ∨ 净持仓 < dust） */
  agentTaskComplete(row: TaskRow): Promise<boolean>;
  /**
   * 意图的 v7 范围检查（不依赖报价的部分）：卖出走独立分支（sellReady、sellableRaw、卖出授权每笔上限 / 剩余 / 步数）；
   * 委托未完成 → DELEGATION_INCOMPLETE；实时额度 / 余额不足 → ALLOWANCE_INSUFFICIENT / BALANCE_INSUFFICIENT。返回签发用的授权。
   */
  intentScope(row: TaskRow, b: { kind: "buy" | "sell"; assetKey: string; outputAssetKey: string; amountInRaw: string }, buyMandate: MandateRow | null): Promise<{ reasons: Reason[]; mandate: MandateRow | null; detail: Record<string, unknown> }>;
  /** 托管执行任务：为刚签发的步骤建作业（不交出 READY 体）；返回 jobId；非托管执行 → null */
  enqueueStep(row: TaskRow, mandate: MandateRow, step: StepRow): Promise<string | null>;
  /** 取消这些步骤的未发送作业（意图被取代 / 撤回 / facts 不过作废） */
  cancelStepJobs(stepIds: string[], code: string): Promise<void>;
}

/** 是否 v7 委托任务（建任务时写了 delegation_json） */
export function isDelegationTask(row: Pick<TaskRow, "delegationJson">): boolean {
  return row.delegationJson !== null && row.delegationJson !== undefined;
}

export const NEEDS_OWNER_TEXT: Record<NeedsOwnerItem["code"], { zh: string; en: string }> = {
  delegation_incomplete: { zh: "委托还没完成：还有签名没签", en: "Delegation is not complete: some signatures are still missing" },
  allowance_low: { zh: "PlanGuard 的额度不够这一步：请再签一次额度签名", en: "PlanGuard's allowance is too low for this step: sign a new allowance" },
  balance_low: { zh: "钱包余额不够这一步", en: "Your wallet balance is too low for this step" },
  permit_failed: { zh: "额度签名没能上链：请重新签", en: "The allowance signature did not land on-chain: sign again" },
  revoke_pending: { zh: "等待链上撤销确认", en: "Waiting for the on-chain revocation" },
  scope_exhausted: { zh: "授权范围已用完（预算 / 笔数 / 期限）：如要继续请建新任务", en: "The signed scope is used up (budget / steps / deadline): create a new task to continue" },
  agent_ended: { zh: "Chaconne Agent 认为任务可以结束：恢复让它继续，或取消并收回额度", en: "Chaconne Agent thinks the task is done: resume to continue, or cancel and reclaim the allowance" },
  reclaim_allowance: { zh: "任务已结束，PlanGuard 还有多余额度：可一键收回", en: "The task has ended and PlanGuard still holds extra allowance: reclaim it" },
};

/**
 * Lane X 的最终合成（替换 agentOnlyTaskRuntime）：executor 段 + 委托 / 额度 / 执行身份相关的 needs（Lane X）
 * 与 Agent presence + agent_ended / 模型与成本相关的 needs（Lane A）合并。presence 的 job 由 jobOf 提供。
 */
export async function composeTaskRuntime(db: Db, row: TaskRow, x: { owner: NeedsOwnerItem[]; operator: NeedsOperatorCode[]; executor: ExecutorStatus }, opts: { agentNeedsOperator?: (taskId: string) => Promise<NeedsOperatorCode[]>; jobOf?: (intentId: string) => Promise<PresenceJob | null> } = {}): Promise<TaskRuntime> {
  const aOwner = agentNeedsOwner(row);
  const aOperator = row.agentMode === "hosted" && opts.agentNeedsOperator ? await opts.agentNeedsOperator(row.id) : [];
  const needsOwner = [...x.owner.filter((n) => !aOwner.some((m) => m.code === n.code)), ...aOwner];
  const needsOperator = [...new Set([...x.operator, ...aOperator])];
  return {
    agentMode: (row.agentMode as AgentMode | null) === "hosted" || row.agentMode === "byo" ? (row.agentMode as AgentMode) : null,
    executorMode: (row.executorMode as ExecutorMode | null) ?? null,
    presence: await agentPresenceFor(db, row, { owner: needsOwner, operator: needsOperator }, opts.jobOf),
    executor: x.executor,
    needsOwner,
    needsOperator,
  };
}
