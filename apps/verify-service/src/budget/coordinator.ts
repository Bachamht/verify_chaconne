/**
 * 资金组协调器（C8，D-086）：服务侧协调，不新增链上预算，不冻结链上余额。
 *
 * 对 Lane B（任务层）暴露的接口 = `BudgetCoordinator`：
 *   reserve   注册授权时预留（全额或 0；0 → state=waiting，任务侧原因码 BUDGET_GROUP_CONFLICT）
 *   markPending 步骤证书被拉取/提交 → 在途占用（计入 reserved 内，不重复）
 *   settle    步骤链上 CONFIRMED → spent += actual，reserved −= actual（按 (mandateId, stepIndex) 幂等）
 *   unpend    步骤链上 REVERTED / 过期作废 → 只解除在途占用，预留仍在
 *   release   授权回滚/过期/撤销**链上确认后**才释放未花出的预留；在途 > 0 拒绝（B-03/B-04）
 *   checkCashFloor 用真实链上余额（B-05/B-06）
 *
 * 并发：进程内按组互斥 + 事务内 `SELECT … FOR UPDATE` 锁组行（B-01）。每次变更后断言不变量并写流水（B-02）。
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "@chaconne/db";
import { verifyBudgetAllocations, verifyBudgetGroups, verifyBudgetLedger } from "@chaconne/db";
import type { BudgetAllocation, BudgetGroup, IsoUtc, RawAmount, ReasonCode } from "@chaconne/core/verify";
import { isRawAmount } from "@chaconne/core/verify";
import { cashFloorCheck, canRelease, invariantHolds, markPending as markPendingPure, reassignWaiting, release as releasePure, requiresPeriodAttribution, settle as settlePure, summarize, tryReserve, type BudgetSummary, type CashFloorCheck } from "@chaconne/core/verify/budget/index";
import { KeyedMutex } from "../payments/lock";
import { HttpError } from "../jobs/service";
import { newId } from "../ids";
import { log } from "../log";

export type GroupRow = typeof verifyBudgetGroups.$inferSelect;
export type AllocationRow = typeof verifyBudgetAllocations.$inferSelect;

import type { BalanceReader } from "../portfolio/chain";
export type { BalanceReader };

export interface ReserveRequest {
  groupId: string;
  taskId: string;
  mandateId: string;
  /** 该授权剩余最大支出（通常 = budgetCap − spent） */
  amountRaw: RawAmount;
  /** 数值小 = 先分配 */
  priority: number;
  mandateDeadline: IsoUtc;
  mandateValidFrom?: IsoUtc;
  /** 跨周期授权必须显式指定归属周期（须等于组周期） */
  attributedPeriod?: { periodStart: IsoUtc; periodEnd: IsoUtc };
}
export interface ReserveResult {
  allocationId: string;
  state: "reserved" | "waiting";
  reservedRaw: RawAmount;
  requestedRaw: RawAmount;
  schedulableRaw: RawAmount;
  reasonCode: Extract<ReasonCode, "BUDGET_GROUP_CONFLICT"> | null;
  groupVersion: number;
  summary: BudgetSummary;
}
export interface SettleResult {
  allocation: AllocationView;
  /** 本次是否真的记账（同 (mandateId, stepIndex) 第二次 → false） */
  applied: boolean;
  promoted: string[];
  summary: BudgetSummary;
}
export interface ReleaseResult {
  allocation: AllocationView | null;
  released: boolean;
  /** 在途 > 0 拒绝释放时的原因 */
  refusedReason: "pending_in_flight" | "not_found" | "already_released" | null;
  promoted: string[];
  summary: BudgetSummary | null;
}
export type AllocationView = BudgetAllocation & { id: string; requestedRaw: RawAmount; periodStart: IsoUtc; periodEnd: IsoUtc; createdAt: IsoUtc; updatedAt: IsoUtc; releaseReason: string | null };

export interface BudgetCoordinator {
  reserve(req: ReserveRequest): Promise<ReserveResult>;
  markPending(mandateId: string, stepIndex: number, amountRaw: RawAmount): Promise<AllocationView | null>;
  settle(mandateId: string, stepIndex: number, actualSpentRaw: RawAmount, ref: { txHash: string | null }): Promise<SettleResult | null>;
  unpend(mandateId: string, stepIndex: number, amountRaw: RawAmount, reason: "reverted" | "expired"): Promise<AllocationView | null>;
  release(mandateId: string, reason: "revoked" | "expired" | "reverted" | "completed", opts?: { force?: boolean }): Promise<ReleaseResult>;
  checkCashFloor(args: { owner: string; inputAssetKey: string; cashFloorRaw: RawAmount; amountRaw: RawAmount }): Promise<CashFloorCheck & { blockNumber: string; reasonCode: Extract<ReasonCode, "CASH_FLOOR_BLOCK"> | null }>;
  allocationFor(mandateId: string): Promise<AllocationView | null>;
  group(groupId: string): Promise<{ group: BudgetGroup & { version: number }; allocations: AllocationView[]; summary: BudgetSummary; invariant: ReturnType<typeof invariantHolds> } | null>;
}

const iso = (d: Date) => d.toISOString();

export function groupView(row: GroupRow): BudgetGroup & { version: number; callerId: string; createdAt: IsoUtc; updatedAt: IsoUtc } {
  return { id: row.id, owner: row.ownerAddress as BudgetGroup["owner"], name: row.name, inputAssetKey: row.inputAssetKey, periodStart: iso(row.periodStart), periodEnd: iso(row.periodEnd), capRaw: row.capRaw, cashFloorRaw: row.cashFloorRaw, priorityRule: "priority_then_created", version: row.version, callerId: row.callerId, createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt) };
}
export function allocationView(row: AllocationRow): AllocationView {
  return { id: row.id, groupId: row.groupId, taskId: row.taskId, mandateId: row.mandateId, priority: row.priority, reservedRaw: row.reservedRaw, spentRaw: row.spentRaw, pendingRaw: row.pendingRaw, state: row.state as BudgetAllocation["state"], requestedRaw: row.requestedRaw, periodStart: iso(row.periodStart), periodEnd: iso(row.periodEnd), createdAt: iso(row.createdAt), updatedAt: iso(row.updatedAt), releaseReason: row.releaseReason };
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

export class DbBudgetCoordinator implements BudgetCoordinator {
  private readonly locks = new KeyedMutex();
  private readonly now: () => Date;
  constructor(private readonly d: { db: Db; balances: BalanceReader; now?: () => Date }) {
    this.now = d.now ?? (() => new Date());
  }

  /* ---------- 内部：锁组行 + 读全部分配 ---------- */
  private async lockGroup(tx: Tx, groupId: string): Promise<{ group: GroupRow; allocations: AllocationRow[] } | null> {
    await tx.execute(sql`select id from verify_budget_groups where id = ${groupId} for update`);
    const group = (await tx.select().from(verifyBudgetGroups).where(eq(verifyBudgetGroups.id, groupId)).limit(1))[0];
    if (!group) return null;
    const allocations = await tx.select().from(verifyBudgetAllocations).where(eq(verifyBudgetAllocations.groupId, groupId)).orderBy(asc(verifyBudgetAllocations.createdAt));
    return { group, allocations };
  }

  private async ledger(tx: Tx, group: GroupRow, allocations: AllocationRow[], kind: string, allocationId: string | null, amountRaw: RawAmount, detail: Record<string, unknown>): Promise<BudgetSummary> {
    const views = allocations.map(allocationView);
    const inv = invariantHolds(group, views);
    const s = summarize(group, views);
    await tx.insert(verifyBudgetLedger).values({ groupId: group.id, allocationId, kind, amountRaw, spentAfterRaw: s.spentRaw, reservedAfterRaw: s.reservedRaw, invariantOk: inv.ok, detail: { ...detail, lhsRaw: inv.lhsRaw, capRaw: inv.capRaw }, createdAt: this.now() });
    await tx.update(verifyBudgetGroups).set({ version: group.version + 1, updatedAt: this.now() }).where(eq(verifyBudgetGroups.id, group.id));
    if (!inv.ok) {
      // 不变量被破坏是编程错误：回滚事务，绝不带着坏账目继续
      throw new Error(`budget invariant violated on group ${group.id}: ${inv.lhsRaw} > ${inv.capRaw} (${kind})`);
    }
    return s;
  }

  /** 释放/结算后把 waiting 的分配按 priority → createdAt 提升 */
  private async promote(tx: Tx, group: GroupRow, allocations: AllocationRow[]): Promise<string[]> {
    const views = allocations.map((a) => ({ ...allocationView(a) }));
    const { promoted } = reassignWaiting(group, views);
    const ids: string[] = [];
    for (const p of promoted) {
      await tx.update(verifyBudgetAllocations).set({ reservedRaw: p.reservedRaw, state: "reserved", updatedAt: this.now() }).where(and(eq(verifyBudgetAllocations.id, p.id), eq(verifyBudgetAllocations.state, "waiting")));
      const row = allocations.find((a) => a.id === p.id)!;
      row.reservedRaw = p.reservedRaw;
      row.state = "reserved";
      ids.push(p.id);
      await tx.insert(verifyBudgetLedger).values({ groupId: group.id, allocationId: p.id, kind: "promote", amountRaw: p.reservedRaw, spentAfterRaw: summarize(group, allocations.map(allocationView)).spentRaw, reservedAfterRaw: summarize(group, allocations.map(allocationView)).reservedRaw, invariantOk: invariantHolds(group, allocations.map(allocationView)).ok, detail: { mandateId: p.mandateId, taskId: p.taskId }, createdAt: this.now() });
    }
    return ids;
  }

  /* ---------- reserve ---------- */
  async reserve(req: ReserveRequest): Promise<ReserveResult> {
    if (!isRawAmount(req.amountRaw)) throw new HttpError(400, "invalid_request", "amountRaw 须为十进制整数串");
    if (!Number.isInteger(req.priority) || req.priority < 0) throw new HttpError(400, "invalid_request", "priority 须为非负整数");
    return this.locks.withLock(`bg:${req.groupId}`, () =>
      this.d.db.transaction(async (tx) => {
        const locked = await this.lockGroup(tx, req.groupId);
        if (!locked) throw new HttpError(404, "budget_group_not_found");
        const { group, allocations } = locked;
        const gv = groupView(group);
        // 跨周期授权必须显式指定归属周期，且必须等于组周期
        if (requiresPeriodAttribution(gv, req.mandateDeadline, req.mandateValidFrom)) {
          if (!req.attributedPeriod) throw new HttpError(400, "period_attribution_required", "授权期限超出组周期：注册时必须指定归属周期（attributedPeriod）", { groupPeriod: { periodStart: gv.periodStart, periodEnd: gv.periodEnd } });
          if (Date.parse(req.attributedPeriod.periodStart) !== Date.parse(gv.periodStart) || Date.parse(req.attributedPeriod.periodEnd) !== Date.parse(gv.periodEnd)) throw new HttpError(400, "period_attribution_mismatch", "归属周期与组周期不一致", { groupPeriod: { periodStart: gv.periodStart, periodEnd: gv.periodEnd } });
        }
        const existing = allocations.find((a) => a.mandateId === req.mandateId);
        if (existing) {
          const s = summarize(group, allocations.map(allocationView));
          return { allocationId: existing.id, state: existing.state === "reserved" ? "reserved" : "waiting", reservedRaw: existing.reservedRaw, requestedRaw: existing.requestedRaw, schedulableRaw: s.schedulableRaw, reasonCode: existing.state === "waiting" ? "BUDGET_GROUP_CONFLICT" : null, groupVersion: group.version, summary: s } satisfies ReserveResult;
        }
        const decision = tryReserve(group, allocations.map(allocationView), req.amountRaw);
        const now = this.now();
        const [row] = await tx
          .insert(verifyBudgetAllocations)
          .values({ id: newId("bal"), groupId: group.id, taskId: req.taskId, mandateId: req.mandateId, priority: req.priority, requestedRaw: req.amountRaw, reservedRaw: decision.reservedRaw, spentRaw: "0", pendingRaw: "0", state: decision.granted ? "reserved" : "waiting", periodStart: group.periodStart, periodEnd: group.periodEnd, releaseReason: null, createdAt: now, updatedAt: now })
          .returning();
        allocations.push(row!);
        const summary = await this.ledger(tx, group, allocations, decision.granted ? "reserve" : "waiting", row!.id, req.amountRaw, { mandateId: req.mandateId, taskId: req.taskId, priority: req.priority, granted: decision.granted });
        log.info("资金组分配", { groupId: group.id, mandateId: req.mandateId, granted: decision.granted, reservedRaw: decision.reservedRaw });
        return { allocationId: row!.id, state: decision.granted ? "reserved" : "waiting", reservedRaw: decision.reservedRaw, requestedRaw: req.amountRaw, schedulableRaw: summary.schedulableRaw, reasonCode: decision.granted ? null : "BUDGET_GROUP_CONFLICT", groupVersion: group.version + 1, summary } satisfies ReserveResult;
      }),
    );
  }

  private async withAllocation<T>(mandateId: string, fn: (tx: Tx, group: GroupRow, allocations: AllocationRow[], alloc: AllocationRow) => Promise<T>): Promise<T | null> {
    const found = (await this.d.db.select({ groupId: verifyBudgetAllocations.groupId }).from(verifyBudgetAllocations).where(eq(verifyBudgetAllocations.mandateId, mandateId)).limit(1))[0];
    if (!found) return null;
    return this.locks.withLock(`bg:${found.groupId}`, () =>
      this.d.db.transaction(async (tx) => {
        const locked = await this.lockGroup(tx, found.groupId);
        if (!locked) return null;
        const alloc = locked.allocations.find((a) => a.mandateId === mandateId);
        if (!alloc) return null;
        return fn(tx, locked.group, locked.allocations, alloc);
      }),
    );
  }

  async markPending(mandateId: string, stepIndex: number, amountRaw: RawAmount): Promise<AllocationView | null> {
    return this.withAllocation(mandateId, async (tx, group, allocations, alloc) => {
      if (alloc.state !== "reserved") return allocationView(alloc);
      const already = (await tx.select({ id: verifyBudgetLedger.id }).from(verifyBudgetLedger).where(and(eq(verifyBudgetLedger.allocationId, alloc.id), eq(verifyBudgetLedger.kind, "pending"), sql`${verifyBudgetLedger.detail}->>'stepIndex' = ${String(stepIndex)}`)).limit(1))[0];
      if (already) return allocationView(alloc);
      const next = markPendingPure(allocationView(alloc), amountRaw);
      alloc.pendingRaw = next.pendingRaw;
      await tx.update(verifyBudgetAllocations).set({ pendingRaw: next.pendingRaw, updatedAt: this.now() }).where(eq(verifyBudgetAllocations.id, alloc.id));
      await this.ledger(tx, group, allocations, "pending", alloc.id, amountRaw, { mandateId, stepIndex });
      return allocationView(alloc);
    });
  }

  async settle(mandateId: string, stepIndex: number, actualSpentRaw: RawAmount, ref: { txHash: string | null }): Promise<SettleResult | null> {
    return this.withAllocation(mandateId, async (tx, group, allocations, alloc) => {
      const already = (await tx.select({ id: verifyBudgetLedger.id }).from(verifyBudgetLedger).where(and(eq(verifyBudgetLedger.allocationId, alloc.id), eq(verifyBudgetLedger.kind, "settle"), sql`${verifyBudgetLedger.detail}->>'stepIndex' = ${String(stepIndex)}`)).limit(1))[0];
      const views = allocations.map(allocationView);
      if (already) return { allocation: allocationView(alloc), applied: false, promoted: [], summary: summarize(group, views) };
      const next = settlePure(allocationView(alloc), actualSpentRaw);
      Object.assign(alloc, { spentRaw: next.spentRaw, reservedRaw: next.reservedRaw, pendingRaw: next.pendingRaw, state: next.state });
      await tx.update(verifyBudgetAllocations).set({ spentRaw: next.spentRaw, reservedRaw: next.reservedRaw, pendingRaw: next.pendingRaw, state: next.state, updatedAt: this.now() }).where(eq(verifyBudgetAllocations.id, alloc.id));
      await this.ledger(tx, group, allocations, "settle", alloc.id, actualSpentRaw, { mandateId, stepIndex, txHash: ref.txHash });
      const promoted = await this.promote(tx, group, allocations);
      return { allocation: allocationView(alloc), applied: true, promoted, summary: summarize(group, allocations.map(allocationView)) };
    });
  }

  async unpend(mandateId: string, stepIndex: number, amountRaw: RawAmount, reason: "reverted" | "expired"): Promise<AllocationView | null> {
    return this.withAllocation(mandateId, async (tx, group, allocations, alloc) => {
      const pending = BigInt(alloc.pendingRaw) - BigInt(amountRaw);
      alloc.pendingRaw = (pending > 0n ? pending : 0n).toString();
      await tx.update(verifyBudgetAllocations).set({ pendingRaw: alloc.pendingRaw, updatedAt: this.now() }).where(eq(verifyBudgetAllocations.id, alloc.id));
      await this.ledger(tx, group, allocations, "unpend", alloc.id, amountRaw, { mandateId, stepIndex, reason });
      return allocationView(alloc);
    });
  }

  async release(mandateId: string, reason: "revoked" | "expired" | "reverted" | "completed", opts: { force?: boolean } = {}): Promise<ReleaseResult> {
    const r = await this.withAllocation(mandateId, async (tx, group, allocations, alloc): Promise<ReleaseResult> => {
      const view = allocationView(alloc);
      const summary = () => summarize(group, allocations.map(allocationView));
      if (alloc.state === "released" || alloc.state === "settled") return { allocation: view, released: false, refusedReason: "already_released", promoted: [], summary: summary() };
      if (!canRelease(view) && !opts.force) return { allocation: view, released: false, refusedReason: "pending_in_flight", promoted: [], summary: summary() };
      const next = releasePure(view);
      Object.assign(alloc, { reservedRaw: "0", pendingRaw: "0", state: "released", releaseReason: reason });
      await tx.update(verifyBudgetAllocations).set({ reservedRaw: next.reservedRaw, pendingRaw: next.pendingRaw, state: "released", releaseReason: reason, updatedAt: this.now() }).where(eq(verifyBudgetAllocations.id, alloc.id));
      await this.ledger(tx, group, allocations, "release", alloc.id, view.reservedRaw, { mandateId, reason, forced: Boolean(opts.force) });
      const promoted = await this.promote(tx, group, allocations);
      log.info("资金组释放", { groupId: group.id, mandateId, reason, promoted: promoted.length });
      return { allocation: allocationView(alloc), released: true, refusedReason: null, promoted, summary: summary() };
    });
    return r ?? { allocation: null, released: false, refusedReason: "not_found", promoted: [], summary: null };
  }

  async checkCashFloor(args: { owner: string; inputAssetKey: string; cashFloorRaw: RawAmount; amountRaw: RawAmount }) {
    const { balanceRaw, blockNumber } = await this.d.balances.balanceOf(args.owner, args.inputAssetKey);
    const c = cashFloorCheck(balanceRaw, args.cashFloorRaw, args.amountRaw);
    return { ...c, blockNumber, reasonCode: c.ok ? null : ("CASH_FLOOR_BLOCK" as const) };
  }

  async allocationFor(mandateId: string): Promise<AllocationView | null> {
    const row = (await this.d.db.select().from(verifyBudgetAllocations).where(eq(verifyBudgetAllocations.mandateId, mandateId)).limit(1))[0];
    return row ? allocationView(row) : null;
  }

  async group(groupId: string) {
    const row = (await this.d.db.select().from(verifyBudgetGroups).where(eq(verifyBudgetGroups.id, groupId)).limit(1))[0];
    if (!row) return null;
    const allocations = (await this.d.db.select().from(verifyBudgetAllocations).where(eq(verifyBudgetAllocations.groupId, groupId)).orderBy(asc(verifyBudgetAllocations.createdAt))).map(allocationView);
    return { group: groupView(row), allocations, summary: summarize(row, allocations), invariant: invariantHolds(row, allocations) };
  }

  /** 组内某些授权的分配（任务视图 / 组合视图用） */
  async allocationsFor(mandateIds: string[]): Promise<AllocationView[]> {
    if (mandateIds.length === 0) return [];
    return (await this.d.db.select().from(verifyBudgetAllocations).where(inArray(verifyBudgetAllocations.mandateId, mandateIds))).map(allocationView);
  }
}
