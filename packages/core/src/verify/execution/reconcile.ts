/**
 * 对账决策与签发闸门（v7 §2.5，CV-D21 / CV-D24）——纯函数，表驱动单测。
 *
 * 关键性质：PlanGuard 对 block.timestamp > validUntil 一律回退，所以签名里的证书有效期就是不确定窗口的上界（≤ 120 s）；
 * 过了窗口且链上步序没动，就可以确定这一步没有执行。
 */
import type { ExecutionJobState, StepReconcileVerdict } from "../contracts";

export interface ReconcileInput {
  stepIndex: number;
  /** 证书里签名的 validUntil（unix 秒） */
  signedValidUntil: number;
  /** 链头区块时间（unix 秒） */
  chainHeadTs: number;
  /** 链上 mandateState(digest).steps */
  chainSteps: number;
  receipt: null | { status: "success" | "reverted"; confirmations: number };
  confirmationsRequired?: number;
  marginS?: number;
}

/**
 * receipt success ∧ confirmations ≥ required → CONFIRMED_BY_RECEIPT
 * receipt success ∧ confirmations <  required → WAIT
 * receipt reverted                            → REVERTED
 * chainSteps > stepIndex                      → EXECUTED_ELSEWHERE（按 MandateStep 日志回填并归因，绝不重发）
 * chainHeadTs > signedValidUntil + marginS    → EXPIRED
 * 其它                                         → WAIT
 */
export function reconcileStep(a: ReconcileInput): StepReconcileVerdict {
  const need = a.confirmationsRequired ?? 6;
  const margin = a.marginS ?? 15;
  if (a.receipt?.status === "success") return a.receipt.confirmations >= need ? "CONFIRMED_BY_RECEIPT" : "WAIT";
  if (a.receipt?.status === "reverted") return "REVERTED";
  if (a.chainSteps > a.stepIndex) return "EXECUTED_ELSEWHERE";
  if (a.chainHeadTs > a.signedValidUntil + margin) return "EXPIRED";
  return "WAIT";
}

export interface GateStepRow {
  id: string;
  state: string;
  pulled: boolean;
  /** 签名 validUntil（unix 秒） */
  signedValidUntil: number;
}
export type IssuanceGateDecision =
  | { action: "backfill" }
  | { action: "wait"; code: "STEP_AWAITING_CONFIRMATION" | "EXECUTION_IN_FLIGHT"; nextCheckAtSec: number | null }
  | { action: "issue"; deleteIds: string[]; supersedeIds: string[] };

/**
 * 签发闸门：给授权 M 的第 n 步签发前，按顺序——
 *   1. 链上 steps > 库里 stepsDone → 先跑链上回填，再评估；
 *   2. (M, n) 的活行为 SUBMITTED / REORG_PENDING → WAIT STEP_AWAITING_CONFIRMATION；
 *   3. (M, n) 的任意状态的行：被取走过且 now ≤ 签名 validUntil + margin → WAIT EXECUTION_IN_FLIGHT（nextCheckAt = validUntil + margin）；
 *   4. (M, n) 的作业处于 SENDING / SENT → WAIT EXECUTION_IN_FLIGHT；
 *   5. 否则：未被取走的旧行删除（CONFIRMED 之外），被取走过的旧行标 SUPERSEDED；然后重签。
 * chainSteps 不可得（RPC 故障）时传 null：跳过第 1 条，其余照常（闸门 3 / 4 仍挡住重复）。
 */
export function issuanceGate(a: { chainSteps: number | null; stepsDone: number; rows: readonly GateStepRow[]; jobs: ReadonlyArray<{ state: ExecutionJobState | string }>; nowSec: number; marginS: number }): IssuanceGateDecision {
  if (a.chainSteps !== null && a.chainSteps > a.stepsDone) return { action: "backfill" };
  if (a.rows.some((r) => r.state === "SUBMITTED" || r.state === "REORG_PENDING")) return { action: "wait", code: "STEP_AWAITING_CONFIRMATION", nextCheckAtSec: null };
  const inflight = a.rows.filter((r) => r.pulled && a.nowSec <= r.signedValidUntil + a.marginS);
  if (inflight.length > 0) return { action: "wait", code: "EXECUTION_IN_FLIGHT", nextCheckAtSec: Math.max(...inflight.map((r) => r.signedValidUntil + a.marginS)) };
  if (a.jobs.some((j) => j.state === "SENDING" || j.state === "SENT")) return { action: "wait", code: "EXECUTION_IN_FLIGHT", nextCheckAtSec: null };
  const old = a.rows.filter((r) => r.state !== "CONFIRMED" && r.state !== "SUPERSEDED");
  return { action: "issue", deleteIds: old.filter((r) => !r.pulled).map((r) => r.id), supersedeIds: old.filter((r) => r.pulled).map((r) => r.id) };
}

/** 被取走过的 PREPARED 行何时可以转 EXPIRED：now > 签名 validUntil + margin；未被取走的行到 validUntil 即可 */
export function stepRowExpirable(a: { pulled: boolean; signedValidUntil: number; nowSec: number; marginS: number; hasInflightJob: boolean }): boolean {
  if (a.hasInflightJob) return false;
  return a.pulled ? a.nowSec > a.signedValidUntil + a.marginS : a.nowSec > a.signedValidUntil;
}

export interface AttributionCandidate {
  id: string;
  state: string;
  evidenceHash: string;
  amountIn: string;
  outputToken: string;
}
/**
 * 回执归因（§2.5 第 5 点）：链上 MandateStep 事件除 (mandateDigest, stepIndex) 外，还要核对 evidenceHash / amountIn / outputToken。
 * 先看活行；不匹配 → 在同 index 的 SUPERSEDED 行里找；都不匹配 → integrity_alert。成交永远记在真正被执行的那张证书上。
 */
export function attributeStepEvent(ev: { evidenceHash: string; amountIn: string; outputToken: string }, live: AttributionCandidate | null, superseded: readonly AttributionCandidate[]): { kind: "live"; id: string } | { kind: "superseded"; id: string; liveId: string | null } | { kind: "integrity_alert" } {
  const match = (c: AttributionCandidate) => c.evidenceHash.toLowerCase() === ev.evidenceHash.toLowerCase() && BigInt(c.amountIn) === BigInt(ev.amountIn) && c.outputToken.toLowerCase() === ev.outputToken.toLowerCase();
  if (live && match(live)) return { kind: "live", id: live.id };
  const s = superseded.find(match);
  if (s) return { kind: "superseded", id: s.id, liveId: live?.id ?? null };
  return { kind: "integrity_alert" };
}
