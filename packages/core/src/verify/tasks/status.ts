/**
 * 任务 12 态状态机（interfaces §11.5；`TASK_STATUSES` 在 contracts.ts）。纯函数：只回答「能不能转」与「评估后该是什么」。
 *
 *  DRAFT ─→ AWAITING_AUTHORIZATION（LIVE）| ACTIVE（SIMULATION）
 *  AWAITING_AUTHORIZATION ─authorize→ ACTIVE ；─cancel→ CANCELLED ；─deadline→ EXPIRED
 *  ACTIVE ⇄ WAITING（条件/证据）；ACTIVE ─issue→ STEP_PREPARED ─confirm→ PARTIAL/COMPLETED ；STEP_PREPARED ─expire/void→ ACTIVE/WAITING
 *  {ACTIVE,WAITING,STEP_PREPARED,PARTIAL} ─pause→ PAUSED ─resume→ ACTIVE（恢复后重评）
 *  {…} ─cancel→ CANCELLED（无链上授权）| REVOKE_PENDING（有链上授权，等 revokeMandate 确认）─confirmed→ REVOKED
 *  {…} ─deadline→ EXPIRED
 * 服务侧 pause/cancel 只阻止后续签发（D-088）：已取走且未过期的证书仍可能可执行，彻底停止以链上撤销确认为准。
 */
import type { ConditionOutcome, TaskStatus } from "../contracts";

const RUNNING: readonly TaskStatus[] = ["ACTIVE", "WAITING", "STEP_PREPARED", "PARTIAL"];
export const TASK_RUNNING_STATUSES: ReadonlySet<TaskStatus> = new Set(RUNNING);
/** monitor 每 tick 评估的状态（PAUSED 仍评估、不签发） */
export const TASK_MONITORED_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([...RUNNING, "PAUSED"]);
export const TASK_TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>(["COMPLETED", "REVOKED", "EXPIRED", "CANCELLED"]);

export const TASK_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  DRAFT: ["AWAITING_AUTHORIZATION", "ACTIVE", "CANCELLED", "EXPIRED"],
  AWAITING_AUTHORIZATION: ["ACTIVE", "WAITING", "CANCELLED", "EXPIRED", "AWAITING_AUTHORIZATION"],
  ACTIVE: ["WAITING", "STEP_PREPARED", "PARTIAL", "COMPLETED", "PAUSED", "CANCELLED", "REVOKE_PENDING", "EXPIRED", "AWAITING_AUTHORIZATION", "ACTIVE"],
  WAITING: ["ACTIVE", "STEP_PREPARED", "PARTIAL", "COMPLETED", "PAUSED", "CANCELLED", "REVOKE_PENDING", "EXPIRED", "AWAITING_AUTHORIZATION", "WAITING"],
  STEP_PREPARED: ["ACTIVE", "WAITING", "PARTIAL", "COMPLETED", "PAUSED", "CANCELLED", "REVOKE_PENDING", "EXPIRED", "AWAITING_AUTHORIZATION", "STEP_PREPARED"],
  PARTIAL: ["ACTIVE", "WAITING", "STEP_PREPARED", "COMPLETED", "PAUSED", "CANCELLED", "REVOKE_PENDING", "EXPIRED", "AWAITING_AUTHORIZATION", "PARTIAL"],
  COMPLETED: [],
  PAUSED: ["ACTIVE", "WAITING", "CANCELLED", "REVOKE_PENDING", "EXPIRED", "PAUSED"],
  REVOKE_PENDING: ["REVOKED", "EXPIRED", "REVOKE_PENDING"],
  REVOKED: [],
  EXPIRED: [],
  CANCELLED: [],
};

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: TaskStatus, to: TaskStatus): void {
  if (!canTransition(from, to)) throw new Error(`task transition ${from} → ${to} not allowed`);
}

/**
 * 评估后的运行态：
 *  - 条件不通过（UNSATISFIED / INSUFFICIENT）或授权层 WAIT → WAITING
 *  - 已签发步骤证书 → STEP_PREPARED
 *  - 否则：已确认过步骤 → PARTIAL；未确认过 → ACTIVE
 */
export function runningStatusAfterEvaluation(args: { current: TaskStatus; outcome: ConditionOutcome; mandateBlocked: boolean; stepIssued: boolean; stepsDone: number; completed: boolean }): TaskStatus {
  if (args.current === "PAUSED") return "PAUSED";
  if (args.completed) return "COMPLETED";
  if (args.stepIssued) return "STEP_PREPARED";
  if (args.outcome !== "SATISFIED" || args.mandateBlocked) return "WAITING";
  return args.stepsDone > 0 ? "PARTIAL" : "ACTIVE";
}

/** 停止语义的固定说明文案（D-088）：三个停止接口的响应体都必须带 */
export const STOP_SEMANTICS_NOTE = "Service-side stop only prevents issuing further step certificates. A certificate that was already pulled and has not expired may still be executable on-chain. To stop completely, the owner must call PlanGuard.revokeMandate(m) and wait for on-chain confirmation (task REVOKE_PENDING → REVOKED).";
