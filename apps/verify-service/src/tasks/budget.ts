/**
 * 任务层看到的资金组接口（C8，D-086）。真身是 Lane C 的 `budget/coordinator.ts DbBudgetCoordinator`（经 `tasks/integrations.ts` 适配）；
 * 无资金组 / C8 关闭时用这里的 stub：全额预留、不冲突、余额未知。
 *   reserve()：注册授权时按 priority → createdAt 分配 reserved（全额或 0；0 → 任务 WAITING(BUDGET_GROUP_CONFLICT)）；
 *   markPending()：prepare-step 拉走证书（READY）时占用在途；settle/unpend 由 C 的回执钩子 withBudgetSettlement 自动接；
 *   release()：C 只认 verify_mandates.state ∈ {EXPIRED,REVOKED,COMPLETED}（syncMandates）；CANCELLED 按 D-088 不释放；
 *   cashFloor()：执行前重查链上余额（cash_floor 用真实余额）；null = 余额未知 → 条件层 INSUFFICIENT；
 *   stepsConfirmedToday()：scope=budget_group 的每日步数；null = 未知。
 */
import type { EvmAddress, RawAmount, ReasonCode } from "@chaconne/core/verify";

export interface BudgetReservationRequest {
  owner: EvmAddress;
  taskId: string;
  mandateId: string | null;
  budgetGroupId: string | null;
  inputAssetKey: string;
  amountRaw: RawAmount;
  priority: number;
  createdAt: string;
  mandateDeadline?: string;
  mandateValidFrom?: string;
}
export interface BudgetReservationResult {
  state: "reserved" | "waiting";
  groupId: string | null;
  reservedRaw: RawAmount;
  /** waiting 时的原因（BUDGET_GROUP_CONFLICT / BUDGET_GROUP_EXHAUSTED / BUDGET_PENDING_OCCUPIED） */
  reason: ReasonCode | null;
  note: string;
  allocationId?: string | null;
}
export interface BudgetCoordinator {
  reserve(req: BudgetReservationRequest): Promise<BudgetReservationResult>;
  markPending(mandateId: string, stepIndex: number, amountRaw: RawAmount): Promise<void>;
  onStepConfirmed(taskId: string, actualSpentRaw: RawAmount): Promise<void>;
  release(taskId: string, reason: "cancelled" | "expired" | "revoked" | "completed"): Promise<void>;
  cashFloor(owner: EvmAddress, inputAssetKey: string): Promise<{ balanceRaw: RawAmount; evidenceId: string } | null>;
  stepsConfirmedToday(budgetGroupId: string, nyDate: string): Promise<number | null>;
}

/** 默认：全额预留、无冲突、余额未知 */
export class FullReserveBudgetCoordinator implements BudgetCoordinator {
  async reserve(req: BudgetReservationRequest): Promise<BudgetReservationResult> {
    return { state: "reserved", groupId: req.budgetGroupId, reservedRaw: req.amountRaw, reason: null, note: req.budgetGroupId ? "budget groups (C8) not enabled; full amount reserved without conflict check" : "no budget group; full amount reserved", allocationId: null };
  }
  async markPending(): Promise<void> {}
  async onStepConfirmed(): Promise<void> {}
  async release(): Promise<void> {}
  async cashFloor(): Promise<null> {
    return null;
  }
  async stepsConfirmedToday(): Promise<number | null> {
    return null;
  }
}
