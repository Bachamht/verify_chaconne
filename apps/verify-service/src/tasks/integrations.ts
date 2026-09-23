/**
 * Lane B ↔ C / D / E 的接缝（签名以各 lane 主分支代码为准，这里只做适配，不复制逻辑）：
 *  - C 资金组：`BudgetCoordinator`（tasks/budget.ts）← `DbBudgetCoordinator`（budget/coordinator.ts）；markPending 在 prepare-step READY 时调；
 *    release 由 C 的 `syncMandates` 按 verify_mandates.state 认（EXPIRED/REVOKED/COMPLETED），CANCELLED 按 D-088 不释放；
 *  - C 通知：`TaskNotifier` ← `NotifyService.notify(...)`；渠道停用的 `TimelineSink` 写进 verify_tasks.timeline；执行器三态 ← `presence(mandateId)`；
 *  - D 事件台：`TasksReader` / `TaskCommands`（impacts/readers.ts）← TasksService；修订传播调 `recheck`；
 *  - E 决策实验：`TaskReader.readTask` ← verify_tasks + 最近一次求值（含证据记录、上下文、事件版本）；`ConditionEvaluator` ← evaluateConditions。
 */
import { eq } from "drizzle-orm";
import type { Db } from "@chaconne/db";
import { verifyTasks } from "@chaconne/db";
import {
  applyFieldStatus,
  assessContextStaleness,
  evaluateConditions,
  type Condition,
  type ConditionEvaluator,
  type ConditionEvidence,
  type ConditionEvidenceInput,
  type ConditionSet,
  type ConditionTaskState as LabTaskState,
  type EvmAddress,
  type LabTaskRecord,
  type MarketEvent,
  type PlanGoal,
  type Task,
  type TaskReader,
  type TaskConditionState,
  type TaskStatus,
} from "@chaconne/core/verify";
import type { BudgetCoordinator as CoreBudgetCoordinator } from "../budget/coordinator";
import type { NotifyService, TimelineSink } from "../notify/service";
import type { CommandResult, HoldingsReader, TaskCommands, TaskLite, TaskRecheck, TasksReader, WatchTaskDraft } from "../impacts/readers";
import type { PortfolioService } from "../portfolio/service";
import { log } from "../log";
import type { BudgetCoordinator, BudgetReservationRequest, BudgetReservationResult } from "./budget";
import type { TaskNotifier } from "./notify";
import type { TaskRow, TasksService } from "./service";
import type { ConditionEvaluationRecord } from "@chaconne/core/verify";

/* ---------------- C：资金组 ---------------- */

export class LaneCBudgetAdapter implements BudgetCoordinator {
  constructor(private readonly c: CoreBudgetCoordinator) {}
  async reserve(req: BudgetReservationRequest): Promise<BudgetReservationResult> {
    if (!req.budgetGroupId) return { state: "reserved", groupId: null, reservedRaw: req.amountRaw, reason: null, note: "no budget group; full amount reserved", allocationId: null };
    if (!req.mandateId) return { state: "reserved", groupId: req.budgetGroupId, reservedRaw: req.amountRaw, reason: null, note: "reservation is taken when the mandate is registered (authorize)", allocationId: null };
    const r = await this.c.reserve({ groupId: req.budgetGroupId, taskId: req.taskId, mandateId: req.mandateId, amountRaw: req.amountRaw, priority: req.priority, mandateDeadline: req.mandateDeadline ?? new Date(Date.parse(req.createdAt) + 30 * 86_400_000).toISOString(), ...(req.mandateValidFrom ? { mandateValidFrom: req.mandateValidFrom } : {}) });
    return { state: r.state, groupId: req.budgetGroupId, reservedRaw: r.reservedRaw, reason: r.reasonCode, note: r.state === "reserved" ? `reserved ${r.reservedRaw} of ${r.requestedRaw} (group v${r.groupVersion})` : `waiting: schedulable ${r.schedulableRaw} < requested ${r.requestedRaw}`, allocationId: r.allocationId };
  }
  async markPending(mandateId: string, stepIndex: number, amountRaw: string): Promise<void> {
    await this.c.markPending(mandateId, stepIndex, amountRaw);
  }
  /** 结算由 C 的回执钩子 withBudgetSettlement 完成 */
  async onStepConfirmed(): Promise<void> {}
  /** 释放由 C 的 syncMandates 按 verify_mandates.state 认；这里不越权 */
  async release(): Promise<void> {}
  async cashFloor(owner: EvmAddress, inputAssetKey: string): Promise<{ balanceRaw: string; evidenceId: string } | null> {
    try {
      const r = await this.c.checkCashFloor({ owner, inputAssetKey, cashFloorRaw: "0", amountRaw: "0" });
      return { balanceRaw: r.balanceRaw, evidenceId: `chain:${inputAssetKey}@${r.blockNumber}` };
    } catch (err) {
      log.warn("链上余额读取失败（cash_floor 视为未知）", { owner, inputAssetKey, error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  }
  async stepsConfirmedToday(): Promise<number | null> {
    return null;
  }
}

/* ---------------- C：通知 / 时间线 / 执行器在线态 ---------------- */

export class LaneCNotifierAdapter implements TaskNotifier {
  constructor(private readonly notify: NotifyService) {}
  async emit(p: Parameters<TaskNotifier["emit"]>[0], ownerAddress: string): Promise<void> {
    await this.notify.notify(p.type, p.entityId, p.version, p.summary, p.url, ownerAddress);
  }
}

/** 渠道停用 / 投递失败写任务时间线（verify_tasks 是 B 的表） */
export function taskTimelineSink(db: Db): TimelineSink {
  return {
    async append(e) {
      const row = (await db.select().from(verifyTasks).where(eq(verifyTasks.id, e.entityId)).limit(1))[0];
      if (!row) return;
      const timeline = [...(row.timelineJson as Array<Record<string, unknown>>), { at: e.at, type: e.kind, note: JSON.stringify(e.detail).slice(0, 500) }].slice(-200);
      await db.update(verifyTasks).set({ timelineJson: timeline }).where(eq(verifyTasks.id, e.entityId));
    },
  };
}

export function executorPresenceFromNotify(notify: NotifyService): (row: TaskRow) => Promise<Task["executorPresence"]> {
  return async (row) => {
    if (row.mandateIds.length === 0) return "offline";
    const p = await notify.presence(row.mandateIds[row.mandateIds.length - 1]!);
    return p.presence;
  };
}

/* ---------------- D：事件台 reader / 命令 ---------------- */

function taskLite(row: TaskRow): TaskLite {
  const goal = row.goalJson as PlanGoal;
  return { id: row.id, owner: row.ownerAddress as EvmAddress, status: row.status as TaskStatus, playbookId: row.playbookId, conditions: { items: (row.conditionsJson as ConditionSet).items }, assetKeys: [...goal.budget.inputAssetKeys, ...goal.legs.map((l) => l.outputAssetKey)], mandateIds: row.mandateIds, ...(row.thesisId ? { thesisId: row.thesisId } : {}), nextCheckAt: row.nextCheckAt?.toISOString() ?? null };
}

export function tasksReaderForLaneD(tasks: TasksService): TasksReader {
  return {
    async tasksOf(owner) {
      const rows = await tasks.listByOwner(owner);
      return { status: "ok", items: rows.map(taskLite) };
    },
    async tasksForEvent(event: MarketEvent) {
      const rows = await tasks.monitoredTasks();
      const hit = rows.filter((r) => (r.conditionsJson as ConditionSet).items.some((c) => (c.type === "earnings_window" && event.kind === "EARNINGS") || (c.type === "avoid_event_window" && c.kinds.includes(event.kind))));
      return { status: "ok", items: hit.map(taskLite) };
    },
  };
}

/** Lane D 持仓读取 = C4 组合快照（只取余额 > 0 的股票；快照失败如实 unavailable，不伪装成「无持仓」） */
export function holdingsForLaneD(portfolio: PortfolioService): HoldingsReader {
  return {
    async holdings(owner) {
      try {
        const snap = await portfolio.snapshot(owner);
        const items = snap.holdings.filter((h) => BigInt(h.balanceRaw) > 0n).map((h) => ({ assetKey: h.assetKey, balanceRaw: h.balanceRaw }));
        return { status: "ok", items, asOf: snap.evidence.time.receivedAt };
      } catch (e) {
        return { status: "unavailable", items: [], note: `PORTFOLIO_SNAPSHOT_FAILED: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
  };
}

export function taskCommandsForLaneD(tasks: TasksService): TaskCommands {
  const notFound = <T,>(): CommandResult<T> => ({ ok: false, code: "TASK_NOT_FOUND", message: "task not found or not owned" });
  return {
    async recheck(r: TaskRecheck): Promise<CommandResult> {
      const row = await tasks.byId(r.taskId);
      if (!row) return notFound();
      // 事件修订 → 立即重评（阻塞项与 nextCheckAt 由求值重新算，不采信传入值）
      await tasks.evaluateTask(row, { issue: false });
      return { ok: true, data: {} };
    },
    async pause(owner, taskId) {
      const row = await tasks.byId(taskId);
      if (!row || row.ownerAddress !== owner.toLowerCase()) return notFound();
      try {
        const { row: updated } = await tasks.transition(row.callerId, taskId, "pause");
        return { ok: true, data: { status: updated.status as TaskStatus } };
      } catch (err) {
        return { ok: false, code: "INVALID", message: err instanceof Error ? err.message : String(err) };
      }
    },
    async create(owner, draft: WatchTaskDraft) {
      try {
        const r = await tasks.create(`web:${owner.toLowerCase()}`, { clientRequestId: draft.clientRequestId, playbookId: draft.playbookId, mode: "SIMULATION", ownerAddress: draft.ownerAddress, params: draft.params, conditions: draft.conditions });
        const t = r.body["task"] as { id: string; status: TaskStatus };
        return { ok: true, data: { taskId: t.id, status: t.status } };
      } catch (err) {
        return { ok: false, code: "INVALID", message: err instanceof Error ? err.message : String(err) };
      }
    },
    async attachCondition(owner, taskId, condition: Condition) {
      const row = await tasks.byId(taskId);
      if (!row || row.ownerAddress !== owner.toLowerCase()) return notFound();
      try {
        const items = [...(row.conditionsJson as ConditionSet).items.filter((c) => c.type !== condition.type && c.type !== "thesis_holds"), condition];
        const updated = await tasks.updateConditions(row.callerId, taskId, { items });
        const requires = updated.mode === "LIVE";
        return { ok: true, data: { requiresNewAuthorization: requires, draftId: requires ? `${taskId}:draft:${updated.conditionsHash.slice(2, 10)}` : null } };
      } catch (err) {
        return { ok: false, code: "INVALID", message: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

/* ---------------- E：任务读取 / 求值器 ---------------- */

export function taskReaderForLaneE(tasks: TasksService): TaskReader {
  return {
    async readTask(taskId): Promise<LabTaskRecord | null> {
      const row = await tasks.byId(taskId);
      if (!row) return null;
      const presence = row.mandateIds.length ? "awaiting_signature" : "offline";
      const task = tasks.taskOf(row, presence);
      const history = await tasks.blockerHistory(taskId, 1);
      const last = history[0] ?? null;
      const rec = last ? (last.evaluationJson as ConditionEvaluationRecord) : null;
      const taskState: LabTaskState = { lastConfirmedStepAt: row.lastConfirmedStepAt?.toISOString() ?? null, stepsConfirmedToday: rec?.input.taskState.stepsConfirmedToday ?? 0, stepsConfirmed: row.stepsConfirmed };
      const latestEvaluation = rec && last
        ? { evaluatedAt: last.evaluatedAt.toISOString(), evaluation: rec.output, evidence: { records: ((last.recordsJson as ConditionEvidenceInput["records"] | null) ?? []), context: rec.input.evidence.context?.snapshot ?? null, events: rec.input.evidence.events.map((e) => e.event) } }
        : null;
      return { task, callerId: row.callerId, taskState, goal: row.goalJson as PlanGoal, latestEvaluation };
    },
  };
}

export const LANE_B_EVALUATOR_ID = "lane-b/conditions-1";

/** Lane E 的对照 / 回放用同一份 evaluateConditions：把 E 的输入形态转成 B 的求值输入 */
export function laneBConditionEvaluator(): ConditionEvaluator {
  return {
    id: LANE_B_EVALUATOR_ID,
    evaluate(set, evidence, taskState, now) {
      const ctx = evidence.context;
      const fieldStatus = ctx ? assessContextStaleness(ctx, now) : {};
      const ctxRecord = evidence.records.find((r) => r.payload.kind === "market_context");
      const events = evidence.events.map((event) => ({ event, evidenceId: evidence.records.find((r) => r.payload.kind === "market_event" && r.payload.eventId === event.id)?.evidenceId ?? `event:${event.id}:${event.revision}` }));
      const pyth = evidence.records.find((r) => r.payload.kind === "pyth_reference");
      const close = evidence.records.find((r) => r.payload.kind === "ref_close");
      const quote = evidence.records.find((r) => r.payload.kind === "okx_quote");
      const ref = pyth ?? close;
      const q: ConditionEvidence["quote"] = ref
        ? { evidenceIds: [ref.evidenceId, ...(quote ? [quote.evidenceId] : [])], executableUsdPerShare: null, referencePriceUsd: ref.payload.kind === "pyth_reference" ? ref.payload.priceUsd : ref.payload.kind === "ref_close" ? ref.payload.closeUsd : null, referenceKind: ref.payload.kind === "pyth_reference" ? "live" : "official_close", premiumBps: null }
        : null;
      const underlyingIds = [...new Set(evidence.events.flatMap((e) => e.underlyingIds))];
      const earningsCoverage: Record<string, boolean> = {};
      for (const u of underlyingIds) if (evidence.events.some((e) => e.kind === "EARNINGS" && e.underlyingIds.includes(u))) earningsCoverage[u] = true;
      const ev: ConditionEvidence = {
        context: ctx ? { snapshot: applyFieldStatus(ctx, fieldStatus), fieldStatus, evidenceId: ctxRecord?.evidenceId ?? "context:snapshot", receivedAt: ctxRecord?.time.receivedAt ?? now } : null,
        events,
        earningsCoverage,
        quote: q,
        balances: {},
        trackedCost: {},
        theses: {},
      };
      const st: TaskConditionState = { underlyingIds, outputAssetKeys: [], mode: "SIMULATION", lastConfirmedStepAt: taskState.lastConfirmedStepAt, stepsConfirmedToday: taskState.stepsConfirmedToday, stepsConfirmedTodayInBudgetGroup: null, nextStepAmountRaw: null };
      return evaluateConditions(set, ev, st, now);
    },
  };
}

/** Recap（Lane F `dbRecapSources.tasksForOwner`）钩子：owner 的任务；callerId 不匹配 → null（私密） */
export function tasksForOwnerHook(tasks: TasksService): (callerId: string, owner: string) => Promise<Task[] | null> {
  return async (callerId, owner) => {
    const rows = await tasks.list(callerId, owner);
    if (rows.length === 0) return null;
    return rows.map((r) => tasks.taskOf(r, r.mandateIds.length ? "awaiting_signature" : "offline"));
  };
}
