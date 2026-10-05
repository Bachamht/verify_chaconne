/**
 * 执行作业状态机（v7 §2.5，D-089 / CV-D21）：只有下表的转移合法；服务端每次改作业状态都先过 canTransitionJob。
 *
 * | 从 → 到                 | 触发                                                       |
 * |-------------------------|------------------------------------------------------------|
 * | QUEUED → CLAIMED        | POST /v1/executor/claim（attempt += 1，租约 90 s，原子取走步骤） |
 * | QUEUED → EXPIRED        | 清扫器（execute_step 证书剩余 < 20 s；permit deadline 剩余 < 120 s） |
 * | QUEUED → CANCELLED      | 暂停 / 撤回 / 被新意图取代 / 接管切换                          |
 * | CLAIMED → QUEUED        | 执行者 abandoned，或清扫器（租约过期、未进 SENDING、证书剩余 ≥ 20 s） |
 * | CLAIMED → SENDING       | 执行者 sending（发送提交点通过）                               |
 * | CLAIMED → FAILED        | 执行者 preflight_failed                                     |
 * | CLAIMED → EXPIRED       | 清扫器（租约过期且证书剩余 < 20 s）/ 发送提交点拒绝（证书剩余不足） |
 * | CLAIMED → CANCELLED     | 发送提交点拒绝（任务暂停 / 步骤不再活 / 作业被取代）/ 接管切换    |
 * | SENDING → SENT          | 执行者 sent                                                  |
 * | SENDING|SENT → CONFIRMED| 回执核实器 / permit 回执 Approval / 对账器（permit 被抢跑）      |
 * | SENDING|SENT → REVERTED | 回执 status 0                                                |
 * | SENDING|SENT → EXPIRED  | 对账器 reconcileStep = EXPIRED                               |
 * | SENDING|SENT → FAILED   | 对账器：permit nonce 已被消耗且无匹配 Approval                  |
 */
import { TERMINAL_EXECUTION_JOB_STATES, type ExecutionJobState } from "../contracts";

const TABLE: Record<ExecutionJobState, readonly ExecutionJobState[]> = {
  QUEUED: ["CLAIMED", "EXPIRED", "CANCELLED"],
  CLAIMED: ["QUEUED", "SENDING", "FAILED", "EXPIRED", "CANCELLED"],
  SENDING: ["SENT", "CONFIRMED", "REVERTED", "EXPIRED", "FAILED"],
  SENT: ["CONFIRMED", "REVERTED", "EXPIRED", "FAILED"],
  CONFIRMED: [],
  REVERTED: [],
  EXPIRED: [],
  FAILED: [],
  CANCELLED: [],
};

export function canTransitionJob(from: ExecutionJobState | string, to: ExecutionJobState | string): boolean {
  const next = TABLE[from as ExecutionJobState];
  return !!next && next.includes(to as ExecutionJobState);
}
export function isTerminalJobState(s: ExecutionJobState | string): boolean {
  return (TERMINAL_EXECUTION_JOB_STATES as readonly string[]).includes(s);
}
/** 已广播或正在广播：这些状态下绝不重签同一步（签发闸门第 4 条） */
export const IN_FLIGHT_JOB_STATES = ["SENDING", "SENT"] as const;
/** 未终结 */
export const OPEN_JOB_STATES = ["QUEUED", "CLAIMED", "SENDING", "SENT"] as const;
/** 可被暂停 / 撤回 / 切换直接取消（从未广播） */
export const CANCELLABLE_JOB_STATES = ["QUEUED", "CLAIMED"] as const;

/** 租约（秒）与时效门槛（秒） */
export const JOB_LEASE_S = 90 as const;
export const QUEUED_MIN_CERT_REMAINING_S = 20 as const;
export const PERMIT_MIN_DEADLINE_REMAINING_S = 120 as const;

export type SendCommitRefusal = { ok: false; code: "task_paused" | "step_not_live" | "step_not_pulled_by_job" | "cert_remaining_low" | "stale_attempt" | "job_not_claimed"; terminal: "CANCELLED" | "EXPIRED" | null };

/**
 * 发送提交点（CLAIMED → SENDING）的服务端复核：任一不满足 → 409 not_allowed_now 并当场终结作业（不等租约），执行者不得广播。
 * permit 作业：stepLive / pulledByJob 传 true；signedValidUntilSec 传 deadline − 120（permit 截止前 2 分钟不再上链）。
 */
export function sendCommitCheck(a: { jobState: ExecutionJobState | string; attemptMatches: boolean; taskPaused: boolean; stepLive: boolean; pulledByJob: boolean; signedValidUntilSec: number; nowSec: number; minRemainingS: number }): { ok: true } | SendCommitRefusal {
  if (!a.attemptMatches) return { ok: false, code: "stale_attempt", terminal: null };
  if (a.jobState !== "CLAIMED") return { ok: false, code: "job_not_claimed", terminal: null };
  if (a.taskPaused) return { ok: false, code: "task_paused", terminal: "CANCELLED" };
  if (!a.stepLive) return { ok: false, code: "step_not_live", terminal: "CANCELLED" };
  if (!a.pulledByJob) return { ok: false, code: "step_not_pulled_by_job", terminal: "CANCELLED" };
  if (a.signedValidUntilSec - a.nowSec < a.minRemainingS) return { ok: false, code: "cert_remaining_low", terminal: "EXPIRED" };
  return { ok: true };
}

/**
 * 清扫器对未发送作业的判定（纯函数）：
 *   QUEUED  + 证书剩余 < 20 s（permit：deadline 剩余 < 120 s）→ EXPIRED
 *   CLAIMED + 租约过期：证书剩余 ≥ 20 s → QUEUED（回队），否则 EXPIRED（从未广播，安全）
 */
export function sweepUnsentJob(a: { kind: "permit" | "execute_step"; state: ExecutionJobState | string; leaseUntilSec: number | null; validUntilSec: number; nowSec: number }): ExecutionJobState | null {
  const minRemain = a.kind === "permit" ? PERMIT_MIN_DEADLINE_REMAINING_S : QUEUED_MIN_CERT_REMAINING_S;
  const remain = a.validUntilSec - a.nowSec;
  if (a.state === "QUEUED") return remain < minRemain ? "EXPIRED" : null;
  if (a.state === "CLAIMED" && a.leaseUntilSec !== null && a.leaseUntilSec <= a.nowSec) return remain >= minRemain ? "QUEUED" : "EXPIRED";
  return null;
}
