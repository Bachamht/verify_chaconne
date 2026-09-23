/**
 * 资金组账目（C8，D-086 服务侧协调；开发计划 v6 §3.3 / interfaces §11.5）。
 * 纯函数：不碰 DB、不碰链。所有金额 bigint / 十进制整数串。
 *
 * 不变量（每次分配 / 结算 / 释放后必须成立）：
 *   spentThisPeriod + Σ reservedRaw(state = reserved) ≤ capRaw
 * pendingRaw（已签发/已提交、尚未链上确认的占用）计入 reservedRaw 内，不重复相加。
 * 周期结束不恢复已成交支出；撤销/到期只释放未花出的剩余额度（reservedRaw → 0），spentRaw 保留。
 */
import type { BudgetAllocation, BudgetGroup, RawAmount } from "../contracts";
import { parseRaw } from "../amounts";

export interface BudgetSummary {
  capRaw: RawAmount;
  /** 本周期已成交买入支出（Σ spentRaw，含已释放/已结算分配） */
  spentRaw: RawAmount;
  /** 仍可执行授权的预留总额（Σ reservedRaw，state = reserved） */
  reservedRaw: RawAmount;
  /** 已签发/提交、待链上确认的占用（计入 reservedRaw 内） */
  pendingRaw: RawAmount;
  /** 可安排额度 = cap − spent − reserved（下限 0） */
  schedulableRaw: RawAmount;
}

export function summarize(group: Pick<BudgetGroup, "capRaw">, allocations: readonly BudgetAllocation[]): BudgetSummary {
  const cap = parseRaw(group.capRaw);
  let spent = 0n;
  let reserved = 0n;
  let pending = 0n;
  for (const a of allocations) {
    spent += parseRaw(a.spentRaw);
    if (a.state === "reserved") {
      reserved += parseRaw(a.reservedRaw);
      pending += parseRaw(a.pendingRaw);
    }
  }
  const schedulable = cap - spent - reserved;
  return { capRaw: cap.toString(), spentRaw: spent.toString(), reservedRaw: reserved.toString(), pendingRaw: pending.toString(), schedulableRaw: (schedulable > 0n ? schedulable : 0n).toString() };
}

/** 不变量断言：返回 ok 与左右两边，便于测试与账目展示 */
export function invariantHolds(group: Pick<BudgetGroup, "capRaw">, allocations: readonly BudgetAllocation[]): { ok: boolean; lhsRaw: RawAmount; capRaw: RawAmount } {
  const s = summarize(group, allocations);
  const lhs = parseRaw(s.spentRaw) + parseRaw(s.reservedRaw);
  const pendingOk = allocations.every((a) => a.state !== "reserved" || parseRaw(a.pendingRaw) <= parseRaw(a.reservedRaw));
  return { ok: lhs <= parseRaw(group.capRaw) && pendingOk, lhsRaw: lhs.toString(), capRaw: group.capRaw };
}

/** priority 数值小 = 先分配；同 priority 按 createdAt 早者先（`priority_then_created`） */
export function orderByPriority<T extends { priority: number; createdAt: string }>(xs: readonly T[]): T[] {
  return [...xs].sort((a, b) => (a.priority !== b.priority ? a.priority - b.priority : a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
}

export interface ReserveDecision {
  /** 全额或 0 */
  granted: boolean;
  reservedRaw: RawAmount;
  schedulableRaw: RawAmount;
}

/** 注册授权时的预留：全额或 0（0 → 分配 waiting，任务侧 BUDGET_GROUP_CONFLICT） */
export function tryReserve(group: Pick<BudgetGroup, "capRaw">, allocations: readonly BudgetAllocation[], amountRaw: RawAmount): ReserveDecision {
  const amount = parseRaw(amountRaw);
  const s = summarize(group, allocations);
  const schedulable = parseRaw(s.schedulableRaw);
  if (amount <= 0n) return { granted: false, reservedRaw: "0", schedulableRaw: s.schedulableRaw };
  if (amount <= schedulable) return { granted: true, reservedRaw: amount.toString(), schedulableRaw: (schedulable - amount).toString() };
  return { granted: false, reservedRaw: "0", schedulableRaw: s.schedulableRaw };
}

/** 步骤已签发/已提交：占用进 pending（≤ reserved，不重复计） */
export function markPending(alloc: BudgetAllocation, amountRaw: RawAmount): BudgetAllocation {
  if (alloc.state !== "reserved") throw new Error(`allocation ${alloc.mandateId} 不在 reserved 态，不能登记在途占用`);
  const next = parseRaw(alloc.pendingRaw) + parseRaw(amountRaw);
  const reserved = parseRaw(alloc.reservedRaw);
  return { ...alloc, pendingRaw: (next > reserved ? reserved : next).toString() };
}

/** 步骤链上确认：spent += actual，reserved −= actual，pending −= actual（各自下限 0） */
export function settle(alloc: BudgetAllocation, actualSpentRaw: RawAmount): BudgetAllocation {
  const actual = parseRaw(actualSpentRaw);
  const reserved = parseRaw(alloc.reservedRaw) - actual;
  const pending = parseRaw(alloc.pendingRaw) - actual;
  const spent = parseRaw(alloc.spentRaw) + actual;
  const reservedNext = reserved > 0n ? reserved : 0n;
  return { ...alloc, spentRaw: spent.toString(), reservedRaw: reservedNext.toString(), pendingRaw: (pending > 0n ? pending : 0n).toString(), state: alloc.state === "reserved" && reservedNext === 0n ? "settled" : alloc.state };
}

/** 回滚 / 过期 / 撤销**链上确认后**：释放未花出的预留；已成交支出保留 */
export function release(alloc: BudgetAllocation): BudgetAllocation {
  return { ...alloc, reservedRaw: "0", pendingRaw: "0", state: "released" };
}

/** 在途占用 > 0 时不得释放（B-03：等链上结果） */
export function canRelease(alloc: BudgetAllocation): boolean {
  return parseRaw(alloc.pendingRaw) === 0n;
}

export interface CashFloorCheck {
  ok: boolean;
  balanceRaw: RawAmount;
  floorRaw: RawAmount;
  amountRaw: RawAmount;
  /** 余额 − 金额 − 下限 < 0 时的缺口 */
  shortfallRaw: RawAmount;
}

/** 现金下限用真实链上余额（B-05 / B-06）：balance − amount ≥ floor */
export function cashFloorCheck(balanceRaw: RawAmount, floorRaw: RawAmount, amountRaw: RawAmount): CashFloorCheck {
  const left = parseRaw(balanceRaw) - parseRaw(amountRaw) - parseRaw(floorRaw);
  return { ok: left >= 0n, balanceRaw, floorRaw, amountRaw, shortfallRaw: (left < 0n ? -left : 0n).toString() };
}

/** 跨周期授权：授权 deadline 晚于组周期结束 → 注册时必须显式指定归属周期 */
export function requiresPeriodAttribution(group: Pick<BudgetGroup, "periodStart" | "periodEnd">, mandateDeadline: string, mandateValidFrom?: string): boolean {
  const end = Date.parse(group.periodEnd);
  const start = Date.parse(group.periodStart);
  const dl = Date.parse(mandateDeadline);
  const vf = mandateValidFrom ? Date.parse(mandateValidFrom) : start;
  return dl > end || vf < start;
}

/** 释放后按 priority → createdAt 让 waiting 分配依次取得预留（全额或 0；一个放不下不阻塞后面更小的） */
export function reassignWaiting<T extends BudgetAllocation & { createdAt: string; requestedRaw: RawAmount }>(group: Pick<BudgetGroup, "capRaw">, allocations: readonly T[]): { promoted: T[]; allocations: T[] } {
  const current = allocations.map((a) => ({ ...a }));
  const promoted: T[] = [];
  for (const w of orderByPriority(current.filter((a) => a.state === "waiting"))) {
    const d = tryReserve(group, current, w.requestedRaw);
    if (!d.granted) continue;
    const idx = current.findIndex((a) => a.mandateId === w.mandateId && a.taskId === w.taskId);
    const next = { ...current[idx]!, reservedRaw: d.reservedRaw, state: "reserved" as const };
    current[idx] = next;
    promoted.push(next);
  }
  return { promoted, allocations: current };
}
