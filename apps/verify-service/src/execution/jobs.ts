/**
 * v7 执行作业仓储（开发计划 §2.5，D-089 / CV-D21 / CV-D24）。verify_mandate_steps 是事实来源；verify_execution_jobs 记执行尝试。
 *
 *   claim     执行者单实例租约 → 带回本地址 SENDING / SENT（recover）→ 否则 FOR UPDATE SKIP LOCKED 取 QUEUED（permit 优先；同授权互斥；
 *             (owner, token) 有在途 permit 时以该代币为输入的 execute_step 不领）→ 同事务原子取走步骤（影响 0 行 → 作业 CANCELLED）
 *   events    attempt 围栏；sending = 发送提交点（任务未暂停、步骤仍是活行且由本作业取走、签名 validUntil 剩余 ≥ 8 s；
 *             再在同一事务里预留费用预算：fees.ts，超限 409 fee_budget_exhausted / 超每笔上限 409 fee_cap_exceeded），拒绝时当场终结作业；
 *             sent → 内部 recordJobSubmission(stepId, txHash) → 步骤 SUBMITTED；permit 回执由服务端自己按 RPC 回执里的 Approval 判定
 *   sweeper   补建缺失作业、租约过期回队、QUEUED / CLAIMED 过期、在途作业对账（reconcileStep）、permit 抢跑对账、自动重签重试
 * 所有状态改动都先过 core canTransitionJob；改状态的 UPDATE 带 WHERE state = from（并发安全）。
 */
import { and, asc, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { Db } from "@chaconne/db";
import { verifyExecutionJobs, verifyExecutorStatus, verifyMandateSteps, verifyPermits, verifyTasks } from "@chaconne/db";
import { canTransitionJob, classifyRevert, decodePermitCalldata, JOB_LEASE_S, reconcileStep, sendCommitCheck, sweepUnsentJob, type ExecuteStepJobPayload, type ExecutionJobState, type FaultSpec, type PermitJobPayload, type RevertClass } from "@chaconne/core/verify";
import { decodeEventLog, keccak256, parseAbi, type Hex } from "viem";
import type { VerifyConfig } from "../config";
import { HttpError } from "../jobs/service";
import { randomBytes } from "node:crypto";
import { log } from "../log";
import { MandatesService, type MandateRow, type StepRow } from "../mandates/service";
import type { ServiceChain } from "./chain";
import type { OpsState } from "./ops";
import type { FeeBudget } from "./fees";

export type JobRow = typeof verifyExecutionJobs.$inferSelect;

/** v7 新表的 id（ids.ts 归 Lane I；这里同一格式：前缀 + 96 bit 随机 hex） */
export function v7Id(prefix: "exj" | "prm"): string {
  return `${prefix}_${randomBytes(12).toString("hex")}`;
}

const APPROVAL_ABI = parseAbi(["event Approval(address indexed owner, address indexed spender, uint256 value)"]);
const INSTANCE_LEASE_S = 90;

export interface JobTerminalInfo {
  job: JobRow;
  state: ExecutionJobState;
  cls: RevertClass | null;
  code: string | null;
}
export interface ExecutionJobsDeps {
  db: Db;
  cfg: VerifyConfig;
  mandates: MandatesService;
  ops: OpsState;
  chain: ServiceChain | null;
  /** 费用预算（D-089 修订）；未装配 = 不预留（只在单测里） */
  fees?: FeeBudget | null;
  now?: () => Date;
  /** 作业终结（EXPIRED / FAILED / REVERTED / CANCELLED / CONFIRMED）→ 任务层：自动重签 / execution_failed 轮次 / needsOwner */
  onTerminal?: (info: JobTerminalInfo) => Promise<void>;
  /** permit 作业确认 → 委托清单（permit 记录 CONFIRMED，buyReady / complete 判定） */
  onPermitResult?: (permitId: string, ok: boolean, info: { txHash: string | null; allowanceAfter: string | null; code: string | null }) => Promise<void>;
}

export interface JobView {
  id: string;
  kind: string;
  state: string;
  attempt: number;
  owner: string;
  token: string | null;
  taskId: string | null;
  mandateId: string | null;
  stepId: string | null;
  stepIndex: number | null;
  validUntil: string | null;
  leaseUntil: string | null;
  payload: unknown;
  fault: FaultSpec | null;
  rawTx: string | null;
  rawTxHash: string | null;
  txHash: string | null;
  errorCode: string | null;
  recover?: boolean;
}

export class ExecutionJobs {
  private readonly now: () => Date;
  constructor(private readonly d: ExecutionJobsDeps) {
    this.now = d.now ?? (() => new Date());
  }
  private nowSec(): number {
    return Math.floor(this.now().getTime() / 1000);
  }
  view(j: JobRow, recover = false): JobView {
    return { id: j.id, kind: j.kind, state: j.state, attempt: j.attempt, owner: j.ownerAddress, token: j.tokenAddress, taskId: j.taskId, mandateId: j.mandateId, stepId: j.stepId, stepIndex: j.stepIndex, validUntil: j.validUntil?.toISOString() ?? null, leaseUntil: j.leaseUntil?.toISOString() ?? null, payload: j.payloadJson, fault: (j.faultJson as FaultSpec | null) ?? null, rawTx: j.rawTx, rawTxHash: j.rawTxHash, txHash: j.txHash, errorCode: j.errorCode, ...(recover ? { recover: true } : {}) };
  }
  async byId(id: string): Promise<JobRow | null> {
    return (await this.d.db.select().from(verifyExecutionJobs).where(eq(verifyExecutionJobs.id, id)).limit(1))[0] ?? null;
  }
  async byStep(stepId: string): Promise<JobRow | null> {
    return (await this.d.db.select().from(verifyExecutionJobs).where(eq(verifyExecutionJobs.stepId, stepId)).limit(1))[0] ?? null;
  }
  async forTask(taskId: string): Promise<JobRow[]> {
    return this.d.db.select().from(verifyExecutionJobs).where(eq(verifyExecutionJobs.taskId, taskId)).orderBy(asc(verifyExecutionJobs.createdAt));
  }

  /** 状态转移（canTransitionJob + WHERE state = from）；返回更新后的行或 null（并发 / 非法） */
  async move(j: JobRow, to: ExecutionJobState, set: Partial<typeof verifyExecutionJobs.$inferInsert> = {}, info: { cls?: RevertClass | null; code?: string | null } = {}): Promise<JobRow | null> {
    if (!canTransitionJob(j.state, to)) {
      log.warn("非法作业转移被拒", { jobId: j.id, from: j.state, to });
      return null;
    }
    const [u] = await this.d.db.update(verifyExecutionJobs).set({ ...set, state: to, updatedAt: this.now() }).where(and(eq(verifyExecutionJobs.id, j.id), eq(verifyExecutionJobs.state, j.state))).returning();
    if (!u) return null;
    // 费用账本：已广播的作业进入终态 → 按回执结算（结果不明则继续占用）
    if ((j.state === "SENDING" || j.state === "SENT") && ["CONFIRMED", "REVERTED", "EXPIRED", "FAILED", "CANCELLED"].includes(to)) await this.d.fees?.onJobTerminal(u, to).catch((err) => log.warn("费用结算失败（清扫器重试）", { jobId: u.id, error: err instanceof Error ? err.message : String(err) }));
    if (["CONFIRMED", "REVERTED", "EXPIRED", "FAILED", "CANCELLED"].includes(to)) await this.d.onTerminal?.({ job: u, state: to, cls: info.cls ?? null, code: info.code ?? u.errorCode ?? null }).catch((err) => log.warn("作业终结回调失败", { jobId: u.id, error: err instanceof Error ? err.message : String(err) }));
    return u;
  }

  /* ---------------- 建作业 ---------------- */

  /** execute_step 作业：托管执行任务里 PREPARED、未取走的步骤（step_id 唯一，重复调用幂等） */
  async createStepJob(m: MandateRow, step: StepRow): Promise<JobRow> {
    const existing = await this.byStep(step.id);
    if (existing) return existing;
    const evaluation = step.evaluationId ? await this.d.mandates.evaluationById(step.evaluationId) : null;
    const validUntil = MandatesService.signedValidUntil(step);
    const payload: ExecuteStepJobPayload = { mandateId: m.id, stepId: step.id, stepIndex: step.stepIndex, validUntil: new Date(validUntil * 1000).toISOString(), ready: this.d.mandates.readyBody(m, step, evaluation) as unknown as Record<string, unknown> };
    const now = this.now();
    const [row] = await this.d.db
      .insert(verifyExecutionJobs)
      .values({ id: v7Id("exj"), kind: "execute_step", taskId: m.taskId, mandateId: m.id, stepId: step.id, stepIndex: step.stepIndex, ownerAddress: m.ownerAddress, tokenAddress: (m.mandateJson as { mandate: { inputToken: string } }).mandate.inputToken.toLowerCase(), payloadJson: payload, state: "QUEUED", attempt: 0, validUntil: new Date(validUntil * 1000), createdAt: now, updatedAt: now })
      .onConflictDoNothing()
      .returning();
    return row ?? (await this.byStep(step.id))!;
  }

  /** permit 作业：同 (owner, token) 有在途 permit → 409 permit_pending（部分唯一索引兜底） */
  async createPermitJob(a: { taskId: string | null; payload: PermitJobPayload }, q: Pick<Db, "insert"> = this.d.db): Promise<JobRow> {
    const now = this.now();
    const owner = a.payload.owner.toLowerCase();
    const token = a.payload.token.toLowerCase();
    try {
      const [row] = await q.insert(verifyExecutionJobs).values({ id: v7Id("exj"), kind: "permit", taskId: a.taskId, mandateId: null, stepId: null, stepIndex: null, ownerAddress: owner, tokenAddress: token, payloadJson: a.payload, state: "QUEUED", attempt: 0, validUntil: new Date(Number(a.payload.deadline) * 1000), createdAt: now, updatedAt: now }).returning();
      return row!;
    } catch (err) {
      if (/unique|duplicate/i.test(err instanceof Error ? `${err.message} ${String((err as { cause?: unknown }).cause ?? "")}` : String(err))) throw new HttpError(409, "permit_pending", "该代币已有一笔在途额度签名正在上链");
      throw err;
    }
  }

  async inflightPermit(owner: string, token: string): Promise<JobRow | null> {
    return (await this.d.db.select().from(verifyExecutionJobs).where(and(eq(verifyExecutionJobs.kind, "permit"), eq(verifyExecutionJobs.ownerAddress, owner.toLowerCase()), eq(verifyExecutionJobs.tokenAddress, token.toLowerCase()), inArray(verifyExecutionJobs.state, ["QUEUED", "CLAIMED", "SENDING", "SENT"]))).limit(1))[0] ?? null;
  }

  /* ---------------- 取消 ---------------- */

  /** 暂停 / 撤回 / 被取代 / 接管切换：取消从未广播的作业（QUEUED / CLAIMED）；返回取消数与在途（SENDING / SENT）数 */
  async cancelUnsent(where: { taskId?: string; mandateId?: string; stepIds?: string[] }, code: string): Promise<{ cancelled: number; inflight: number }> {
    const conds = [where.taskId ? eq(verifyExecutionJobs.taskId, where.taskId) : undefined, where.mandateId ? eq(verifyExecutionJobs.mandateId, where.mandateId) : undefined, where.stepIds ? (where.stepIds.length ? inArray(verifyExecutionJobs.stepId, where.stepIds) : sql`false`) : undefined].filter(Boolean);
    const rows = await this.d.db.select().from(verifyExecutionJobs).where(and(...(conds as never[]), inArray(verifyExecutionJobs.state, ["QUEUED", "CLAIMED", "SENDING", "SENT"])));
    let cancelled = 0;
    let inflight = 0;
    for (const j of rows) {
      if (j.state === "SENDING" || j.state === "SENT") {
        inflight += 1;
        continue;
      }
      if (await this.move(j, "CANCELLED", { errorCode: code }, { code })) cancelled += 1;
    }
    return { cancelled, inflight };
  }

  /** 步骤行状态变化（MandatesService 钩子）→ 作业同步 */
  async onStepState(stepId: string, state: string): Promise<void> {
    const j = await this.byStep(stepId);
    if (!j) return;
    if (state === "CONFIRMED" && (j.state === "SENDING" || j.state === "SENT")) await this.move(j, "CONFIRMED");
    else if (state === "CONFIRMED" && (j.state === "QUEUED" || j.state === "CLAIMED")) await this.move(j, "CANCELLED", { errorCode: "executed_elsewhere" }, { code: "executed_elsewhere" });
    else if (state === "REVERTED" && (j.state === "SENDING" || j.state === "SENT")) await this.move(j, "REVERTED", { errorCode: "reverted" }, { code: "reverted" });
    else if ((state === "EXPIRED" || state === "SUPERSEDED") && (j.state === "QUEUED" || j.state === "CLAIMED")) await this.move(j, state === "EXPIRED" ? "EXPIRED" : "CANCELLED", { errorCode: state === "EXPIRED" ? "step_expired" : "superseded" }, { cls: state === "EXPIRED" ? "retry_new_cert" : null, code: state === "EXPIRED" ? "step_expired" : "superseded" });
  }

  /* ---------------- 执行者心跳与单实例租约 ---------------- */

  private async takeInstanceLease(executor: string, instanceId: string, extra: Partial<typeof verifyExecutorStatus.$inferInsert> = {}): Promise<boolean> {
    const now = this.now();
    const lease = new Date(now.getTime() + INSTANCE_LEASE_S * 1000);
    const cur = (await this.d.db.select().from(verifyExecutorStatus).where(eq(verifyExecutorStatus.executor, executor)).limit(1))[0];
    if (cur && cur.activeInstance && cur.activeInstance !== instanceId && cur.instanceLeaseUntil && cur.instanceLeaseUntil.getTime() > now.getTime()) return false;
    if (!cur) {
      await this.d.db.insert(verifyExecutorStatus).values({ executor, activeInstance: instanceId, instanceLeaseUntil: lease, updatedAt: now, ...extra }).onConflictDoNothing();
      return true;
    }
    const [u] = await this.d.db
      .update(verifyExecutorStatus)
      .set({ activeInstance: instanceId, instanceLeaseUntil: lease, updatedAt: now, ...extra })
      .where(and(eq(verifyExecutorStatus.executor, executor), or(eq(verifyExecutorStatus.activeInstance, instanceId), isNull(verifyExecutorStatus.activeInstance), isNull(verifyExecutorStatus.instanceLeaseUntil), lt(verifyExecutorStatus.instanceLeaseUntil, now))))
      .returning();
    return !!u;
  }

  private readonly gasLowBy = new Map<string, boolean>();
  /** 执行者自报 gas 低于 EXECUTOR_MIN_OKB_WEI（阈值在执行进程里；服务端据此报 executor_gas_low） */
  gasLow(executor: string): boolean {
    return this.gasLowBy.get(executor.toLowerCase()) ?? false;
  }
  async heartbeat(b: { executor: string; instanceId: string; mode: string; gasBalanceWei: string; chainHead: string; version: string; gasLow?: boolean }): Promise<void> {
    this.gasLowBy.set(b.executor.toLowerCase(), b.gasLow === true);
    const ok = await this.takeInstanceLease(b.executor, b.instanceId, { mode: b.mode, lastHeartbeatAt: this.now(), gasBalanceWei: b.gasBalanceWei, chainHead: b.chainHead, version: b.version.slice(0, 64) });
    if (!ok) throw new HttpError(409, "executor_instance_conflict", "同一执行身份已有另一个实例在运行");
  }

  async executorStatuses() {
    return this.d.db.select().from(verifyExecutorStatus);
  }

  /* ---------------- 领取 ---------------- */

  async claim(b: { executor: string; instanceId: string; kinds?: string[]; max?: number }): Promise<JobView[]> {
    const executor = b.executor.toLowerCase();
    if (!(await this.takeInstanceLease(executor, b.instanceId))) throw new HttpError(409, "executor_instance_conflict", "同一执行身份已有另一个实例在运行");
    // 1. 崩溃恢复：本地址 SENDING / SENT 作业
    const recover = await this.d.db.select().from(verifyExecutionJobs).where(and(eq(verifyExecutionJobs.claimedBy, executor), inArray(verifyExecutionJobs.state, ["SENDING", "SENT"]))).orderBy(asc(verifyExecutionJobs.updatedAt));
    if (recover.length) return recover.map((j) => this.view(j, true));
    const max = Math.max(1, Math.min(5, b.max ?? 1));
    const kinds = (b.kinds ?? ["permit", "execute_step"]).filter((k) => k === "permit" || k === "execute_step");
    const out: JobView[] = [];
    for (let i = 0; i < max; i++) {
      const j = await this.claimOne(executor, b.instanceId, kinds);
      if (!j) break;
      out.push(this.view(j));
    }
    return out;
  }

  private async claimOne(executor: string, instanceId: string, kinds: string[]): Promise<JobRow | null> {
    const nowDate = this.now();
    return this.d.db.transaction(async (tx) => {
      // permit 优先；FOR UPDATE SKIP LOCKED：并发领取者跳过已被锁住的行
      const cands = (await tx.execute(sql`SELECT id FROM verify_execution_jobs WHERE state = 'QUEUED' AND kind = ANY(${`{${kinds.join(",")}}`}::text[]) ORDER BY CASE WHEN kind = 'permit' THEN 0 ELSE 1 END, created_at FOR UPDATE SKIP LOCKED LIMIT 20`)) as unknown as { rows?: Array<{ id: string }> } | Array<{ id: string }>;
      const ids = (Array.isArray(cands) ? cands : (cands.rows ?? [])).map((r) => r.id);
      for (const id of ids) {
        const j = (await tx.select().from(verifyExecutionJobs).where(eq(verifyExecutionJobs.id, id)).limit(1))[0];
        if (!j || j.state !== "QUEUED") continue;
        if (j.kind === "execute_step") {
          // 同一授权同时最多 1 个 CLAIMED / SENDING / SENT
          const busy = (await tx.select({ id: verifyExecutionJobs.id }).from(verifyExecutionJobs).where(and(eq(verifyExecutionJobs.mandateId, j.mandateId!), inArray(verifyExecutionJobs.state, ["CLAIMED", "SENDING", "SENT"]))).limit(1))[0];
          if (busy) continue;
          // (owner, token) 有在途 permit：以该代币为输入的 execute_step 暂不领取
          const permitBusy = (await tx.select({ id: verifyExecutionJobs.id }).from(verifyExecutionJobs).where(and(eq(verifyExecutionJobs.kind, "permit"), eq(verifyExecutionJobs.ownerAddress, j.ownerAddress), eq(verifyExecutionJobs.tokenAddress, j.tokenAddress ?? ""), inArray(verifyExecutionJobs.state, ["QUEUED", "CLAIMED", "SENDING", "SENT"]))).limit(1))[0];
          if (permitBusy) continue;
          // 原子取走步骤：首次领取要求 pulled_at IS NULL；回队后再领取（attempt > 0）要求步骤仍是活的 PREPARED（只有本作业取走过它，step_id 唯一）
          const pulled = await tx
            .update(verifyMandateSteps)
            .set({ pulledAt: nowDate, updatedAt: nowDate })
            .where(and(eq(verifyMandateSteps.id, j.stepId!), eq(verifyMandateSteps.state, "PREPARED"), isNull(verifyMandateSteps.txHash), ...(j.attempt === 0 ? [isNull(verifyMandateSteps.pulledAt)] : [])))
            .returning({ id: verifyMandateSteps.id });
          if (pulled.length === 0) {
            await tx.update(verifyExecutionJobs).set({ state: "CANCELLED", errorCode: "step_not_pullable", updatedAt: nowDate }).where(and(eq(verifyExecutionJobs.id, j.id), eq(verifyExecutionJobs.state, "QUEUED")));
            continue;
          }
        }
        const fault = this.d.cfg.v7.faultInjection ? this.d.ops.takeFault({ kind: j.kind, taskId: j.taskId }) : null;
        // double_claim（只在分叉 / 本地演练）：租约直接记为已过期 → 清扫器回队 → 另一执行者领取；旧 attempt 的事件被围栏拒绝
        const leaseUntil = fault?.kind === "double_claim" ? new Date(nowDate.getTime() - 1000) : new Date(nowDate.getTime() + JOB_LEASE_S * 1000);
        if (!canTransitionJob(j.state, "CLAIMED")) continue;
        const [u] = await tx
          .update(verifyExecutionJobs)
          .set({ state: "CLAIMED", attempt: j.attempt + 1, leaseUntil, claimedBy: executor, instanceId, faultJson: fault ?? (j.faultJson as FaultSpec | null) ?? null, updatedAt: nowDate })
          .where(and(eq(verifyExecutionJobs.id, j.id), eq(verifyExecutionJobs.state, "QUEUED")))
          .returning();
        if (u) return u;
      }
      return null;
    });
  }

  /* ---------------- 执行者事件 ---------------- */

  async event(executor: string, jobId: string, b: Record<string, unknown>): Promise<{ status: 200; job: JobView }> {
    const j0 = await this.byId(jobId);
    if (!j0) throw new HttpError(404, "job_not_found");
    const attempt = Number(b["attempt"]);
    if (j0.claimedBy !== executor.toLowerCase() || attempt !== j0.attempt) throw new HttpError(409, "stale_attempt", "该作业已被重新领取（attempt 不匹配）：旧 attempt 的事件一律拒绝", { attempt: j0.attempt });
    const type = String(b["type"] ?? "");
    let j = j0;
    if (type === "sending") j = await this.onSending(j, b);
    else if (type === "sent") j = await this.onSent(j, b);
    else if (type === "preflight_failed") j = await this.onPreflightFailed(j, b);
    else if (type === "receipt") j = await this.onReceipt(j, b);
    else if (type === "abandoned") j = await this.onAbandoned(j);
    else throw new HttpError(400, "invalid_event_type", "type 必须是 sending | sent | preflight_failed | receipt | abandoned");
    return { status: 200, job: this.view(j) };
  }

  private refuse(code: string, j: JobRow): never {
    throw new HttpError(409, "not_allowed_now", `发送提交点拒绝：${code}；不得广播`, { code, jobState: j.state });
  }

  private async onSending(j: JobRow, b: Record<string, unknown>): Promise<JobRow> {
    const rawTxHash = typeof b["rawTxHash"] === "string" && /^0x[0-9a-fA-F]{64}$/.test(b["rawTxHash"]) ? b["rawTxHash"].toLowerCase() : null;
    const rawTx = typeof b["rawTx"] === "string" && /^0x[0-9a-fA-F]+$/.test(b["rawTx"]) && b["rawTx"].length <= 64_000 ? b["rawTx"] : null;
    const nonce = typeof b["nonce"] === "string" && /^\d+$/.test(b["nonce"]) ? b["nonce"] : null;
    // 崩溃恢复：同一 rawTxHash 再次确认 → 证书仍有效即同意原样重播
    if (j.state === "SENDING") {
      if (!rawTxHash || rawTxHash !== j.rawTxHash) this.refuse("sending_mismatch", j);
      const remain = (j.validUntil ? Math.floor(j.validUntil.getTime() / 1000) : 0) - this.nowSec();
      if (j.kind === "execute_step" && remain < this.d.cfg.EXECUTOR_MIN_CERT_REMAINING_S) this.refuse("cert_remaining_low", j);
      return j;
    }
    const st = (await this.d.db.select().from(verifyExecutorStatus).where(eq(verifyExecutorStatus.executor, j.claimedBy!)).limit(1))[0];
    if ((st?.mode ?? "eoa") === "eoa" && (!rawTxHash || !rawTx || !nonce)) throw new HttpError(400, "sending_requires_raw_tx", "EOA 模式的 sending 必须带 rawTxHash / nonce / rawTx");
    if (rawTx && rawTxHash && keccak256(rawTx as Hex).toLowerCase() !== rawTxHash) throw new HttpError(400, "raw_tx_hash_mismatch", "rawTxHash 必须等于 keccak256(rawTx)");
    let check: ReturnType<typeof sendCommitCheck>;
    if (j.kind === "execute_step") {
      const step = j.stepId ? await this.d.mandates.stepById(j.stepId) : null;
      const m = j.mandateId ? await this.d.mandates.byId(j.mandateId) : null;
      const task = j.taskId ? (await this.d.db.select({ status: verifyTasks.status }).from(verifyTasks).where(eq(verifyTasks.id, j.taskId)).limit(1))[0] : null;
      const paused = task?.status === "PAUSED" || !m || m.state !== "ACTIVE";
      check = sendCommitCheck({ jobState: j.state, attemptMatches: true, taskPaused: paused, stepLive: !!step && step.state === "PREPARED" && !step.txHash, pulledByJob: !!step?.pulledAt, signedValidUntilSec: step ? MandatesService.signedValidUntil(step) : 0, nowSec: this.nowSec(), minRemainingS: this.d.cfg.EXECUTOR_MIN_CERT_REMAINING_S });
      // 白名单纵深防御：raw tx 必须发往 PlanGuard（无法解析时不放行）
    } else {
      const p = j.payloadJson as PermitJobPayload;
      const permit = (await this.d.db.select({ state: verifyPermits.state }).from(verifyPermits).where(eq(verifyPermits.id, p.permitId)).limit(1))[0];
      check = sendCommitCheck({ jobState: j.state, attemptMatches: true, taskPaused: false, stepLive: permit?.state === "SUBMITTED", pulledByJob: true, signedValidUntilSec: Number(p.deadline) - 120, nowSec: this.nowSec(), minRemainingS: 0 });
    }
    if (!check.ok) {
      if (check.terminal) await this.move(j, check.terminal, { errorCode: check.code }, { cls: check.code === "cert_remaining_low" ? "retry_new_cert" : null, code: check.code });
      this.refuse(check.code, j);
    }
    if (!this.d.fees) {
      const u = await this.move(j, "SENDING", { rawTx, rawTxHash, txNonce: nonce });
      if (!u) this.refuse("concurrent_update", j);
      return u;
    }
    // 费用预算：预留与转 SENDING 在同一事务（咨询锁串行），超限当场终结作业、执行者不得广播
    if (!canTransitionJob(j.state, "SENDING")) this.refuse("illegal_transition", j);
    const CONCURRENT = Symbol("concurrent");
    let outcome: { ok: true; job: JobRow } | Extract<Awaited<ReturnType<FeeBudget["reserveInTx"]>>, { ok: false }>;
    try {
      outcome = await this.d.db.transaction(async (tx) => {
        const r = await this.d.fees!.reserveInTx(tx, { ...j, rawTxHash }, rawTx);
        if (!r.ok) return r;
        const [u] = await tx.update(verifyExecutionJobs).set({ rawTx, rawTxHash, txNonce: nonce, state: "SENDING", updatedAt: this.now() }).where(and(eq(verifyExecutionJobs.id, j.id), eq(verifyExecutionJobs.state, "CLAIMED"))).returning();
        if (!u) throw CONCURRENT;
        return { ok: true as const, job: u };
      });
    } catch (err) {
      if (err === CONCURRENT) this.refuse("concurrent_update", j);
      throw err;
    }
    if (outcome.ok) return outcome.job;
    const r = outcome;
    const failed = await this.move(j, "FAILED", { errorCode: r.code, errorDetail: r.message.slice(0, 500), resultJson: { fee: { scope: r.scope, usedWei: r.usedWei, limitWei: r.limitWei, needWei: r.needWei } } }, { code: r.code });
    if (failed?.kind === "permit") await this.d.onPermitResult?.((failed.payloadJson as PermitJobPayload).permitId, false, { txHash: null, allowanceAfter: null, code: r.code });
    await this.d.fees.alertOperator(r.code, `job ${j.id} (${j.kind}, task ${j.taskId ?? "-"}, owner ${j.ownerAddress}) refused at the send-commit point: ${r.message}`);
    throw new HttpError(409, r.code, `send-commit point refused: ${r.code} (${r.scope}); the executor must not broadcast`, { code: r.code, scope: r.scope, usedWei: r.usedWei, limitWei: r.limitWei, needWei: r.needWei, jobState: "FAILED" });
  }

  private async onSent(j: JobRow, b: Record<string, unknown>): Promise<JobRow> {
    const txHash = typeof b["txHash"] === "string" && /^0x[0-9a-fA-F]{64}$/.test(b["txHash"]) ? b["txHash"].toLowerCase() : null;
    if (!txHash) throw new HttpError(400, "invalid_tx_hash");
    if (j.state === "SENT" && j.txHash === txHash) return j;
    if (j.state !== "SENDING") throw new HttpError(409, "not_allowed_now", `作业状态 ${j.state} 不接受 sent`);
    if (j.rawTxHash && j.rawTxHash !== txHash) this.d.ops.alert("tx_hash_mismatch", { taskId: j.taskId, mandateId: j.mandateId, detail: `job ${j.id} committed raw ${j.rawTxHash} but executor reported ${txHash}` });
    const u = await this.move(j, "SENT", { txHash });
    if (!u) throw new HttpError(409, "concurrent_update");
    if (u.kind === "execute_step" && u.stepId) await this.d.mandates.recordJobSubmission(u.stepId, txHash);
    return u;
  }

  private async onPreflightFailed(j: JobRow, b: Record<string, unknown>): Promise<JobRow> {
    if (j.state !== "CLAIMED") throw new HttpError(409, "not_allowed_now", `作业状态 ${j.state} 不接受 preflight_failed`);
    const code = typeof b["code"] === "string" ? b["code"].slice(0, 64) : "preflight_failed";
    const rv = b["revert"] as { cls?: string; error?: string | null; message?: string } | null | undefined;
    const pre = { cert_remaining_low: "cert_remaining_low", allowance_low: "allowance_low", balance_low: "balance_low", step_index_mismatch: "step_index_mismatch", mandate_revoked: "mandate_revoked" } as const;
    const cls: RevertClass = code in pre ? classifyRevert({ preflight: pre[code as keyof typeof pre] }).cls : rv?.error ? classifyRevert({ errorName: rv.error }).cls : rv?.message ? classifyRevert({ message: rv.message }).cls : code.startsWith("permit_") ? "unknown" : "unknown";
    const detail = [typeof b["detail"] === "string" ? b["detail"] : null, rv?.message ?? null].filter(Boolean).join(" | ").slice(0, 500) || null;
    const u = await this.move(j, "FAILED", { errorCode: code, errorDetail: detail, resultJson: { cls, revert: rv ?? null } }, { cls, code });
    if (!u) throw new HttpError(409, "concurrent_update");
    if (u.kind === "permit") await this.d.onPermitResult?.((u.payloadJson as PermitJobPayload).permitId, false, { txHash: null, allowanceAfter: null, code });
    if (cls === "chain_ahead" && u.mandateId) {
      const m = await this.d.mandates.byId(u.mandateId);
      if (m) await this.d.mandates.backfillMandate(m).catch(() => undefined);
    }
    return u;
  }

  private async onReceipt(j: JobRow, b: Record<string, unknown>): Promise<JobRow> {
    // 执行者的回执只是提示：execute_step 由回执核实器确认；permit 由服务端自己读 RPC 回执里的 Approval 判定
    await this.d.db.update(verifyExecutionJobs).set({ resultJson: { ...((j.resultJson as Record<string, unknown> | null) ?? {}), reportedReceipt: { status: b["status"] ?? null, blockNumber: b["blockNumber"] ?? null, at: this.now().toISOString() } }, updatedAt: this.now() }).where(eq(verifyExecutionJobs.id, j.id));
    if (j.kind === "permit" && (j.state === "SENDING" || j.state === "SENT")) await this.checkPermitReceipt((await this.byId(j.id))!);
    return (await this.byId(j.id))!;
  }

  private async onAbandoned(j: JobRow): Promise<JobRow> {
    if (j.state !== "CLAIMED") throw new HttpError(409, "not_allowed_now", `作业状态 ${j.state} 不接受 abandoned`);
    const next = sweepUnsentJob({ kind: j.kind as "permit" | "execute_step", state: "CLAIMED", leaseUntilSec: 0, validUntilSec: j.validUntil ? Math.floor(j.validUntil.getTime() / 1000) : 0, nowSec: this.nowSec() }) ?? "QUEUED";
    const u = await this.move(j, next, next === "QUEUED" ? { leaseUntil: null, claimedBy: null, instanceId: null } : { errorCode: "abandoned_expired" }, { cls: next === "EXPIRED" ? "retry_new_cert" : null, code: "abandoned" });
    if (!u) throw new HttpError(409, "concurrent_update");
    return u;
  }

  /* ---------------- permit 回执 ---------------- */

  /** 回执里 Approval(owner, PlanGuard, value) == 签名 value → CONFIRMED；status 0 → REVERTED */
  async checkPermitReceipt(j: JobRow): Promise<void> {
    if (!this.d.chain || !j.txHash) return;
    const p = j.payloadJson as PermitJobPayload;
    const r = await this.d.chain.getReceipt(j.txHash as Hex).catch(() => null);
    if (!r) return;
    if (r.status === "reverted") {
      const u = await this.move(j, "REVERTED", { errorCode: "permit_reverted" }, { code: "permit_reverted" });
      if (u) await this.d.onPermitResult?.(p.permitId, false, { txHash: j.txHash, allowanceAfter: null, code: "permit_reverted" });
      return;
    }
    let matched = false;
    for (const l of r.logs) {
      if (l.address.toLowerCase() !== p.token.toLowerCase() || l.topics.length === 0) continue;
      try {
        const d = decodeEventLog({ abi: APPROVAL_ABI, data: l.data, topics: l.topics as [Hex, ...Hex[]] });
        const a = d.args as { owner: string; spender: string; value: bigint };
        if (a.owner.toLowerCase() === p.owner.toLowerCase() && a.spender.toLowerCase() === p.spender.toLowerCase() && a.value.toString() === p.value) matched = true;
      } catch {
        /* 其它事件 */
      }
    }
    if (!matched) {
      this.d.ops.alert("permit_approval_missing", { taskId: j.taskId, detail: `permit tx ${j.txHash} succeeded without a matching Approval(owner, spender, value)` });
      return;
    }
    const allowance = await this.d.chain.allowance(p.token, p.owner, p.spender).catch(() => null);
    const u = await this.move(j, "CONFIRMED", { resultJson: { ...((j.resultJson as Record<string, unknown> | null) ?? {}), approval: { value: p.value, blockNumber: r.blockNumber.toString() } } });
    if (u) await this.d.onPermitResult?.(p.permitId, true, { txHash: j.txHash, allowanceAfter: allowance?.toString() ?? null, code: null });
  }

  /* ---------------- 清扫器 ---------------- */

  async sweep(): Promise<{ created: number; moved: number }> {
    let created = 0;
    let moved = 0;
    const now = this.now();
    const nowSec = this.nowSec();
    // 1. 补建：托管执行任务里 PREPARED、未取走、无作业的步骤
    const hostedTasks = await this.d.db.select({ id: verifyTasks.id, mandateIds: verifyTasks.mandateIds }).from(verifyTasks).where(and(eq(verifyTasks.executorMode, "hosted"), inArray(verifyTasks.status, ["ACTIVE", "WAITING", "STEP_PREPARED", "PARTIAL"])));
    const mids = hostedTasks.flatMap((t) => t.mandateIds);
    if (mids.length) {
      const steps = await this.d.db.select().from(verifyMandateSteps).where(and(inArray(verifyMandateSteps.mandateId, mids), eq(verifyMandateSteps.state, "PREPARED"), isNull(verifyMandateSteps.pulledAt), isNull(verifyMandateSteps.txHash)));
      for (const s of steps) {
        if (await this.byStep(s.id)) continue;
        if (MandatesService.signedValidUntil(s) - nowSec < 20) continue;
        const m = await this.d.mandates.byId(s.mandateId);
        if (!m || m.state !== "ACTIVE") continue;
        await this.createStepJob(m, s);
        created += 1;
      }
    }
    // 2. 未发送作业：QUEUED 过期、CLAIMED 租约过期回队 / 过期
    const unsent = await this.d.db.select().from(verifyExecutionJobs).where(inArray(verifyExecutionJobs.state, ["QUEUED", "CLAIMED"]));
    for (const j of unsent) {
      const next = sweepUnsentJob({ kind: j.kind as "permit" | "execute_step", state: j.state, leaseUntilSec: j.leaseUntil ? Math.floor(j.leaseUntil.getTime() / 1000) : null, validUntilSec: j.validUntil ? Math.floor(j.validUntil.getTime() / 1000) : nowSec, nowSec });
      if (!next) continue;
      const u = await this.move(j, next, next === "QUEUED" ? { leaseUntil: null, claimedBy: null, instanceId: null } : { errorCode: j.state === "QUEUED" ? "expired_unclaimed" : "lease_expired" }, { cls: next === "EXPIRED" && j.kind === "execute_step" ? "retry_new_cert" : null, code: next === "EXPIRED" ? "expired_before_send" : null });
      if (u) {
        moved += 1;
        if (u.kind === "permit" && next === "EXPIRED") await this.d.onPermitResult?.((u.payloadJson as PermitJobPayload).permitId, false, { txHash: null, allowanceAfter: null, code: "permit_expired" });
      }
    }
    // 3. 在途作业对账（需要链）
    if (this.d.chain) {
      const inflight = await this.d.db.select().from(verifyExecutionJobs).where(inArray(verifyExecutionJobs.state, ["SENDING", "SENT"]));
      let head: { number: bigint; timestamp: bigint } | null = null;
      for (const j of inflight) {
        try {
          head ??= await this.d.chain.head();
          if (j.kind === "permit") await this.reconcilePermit(j, head);
          else moved += (await this.reconcileStepJob(j, head)) ? 1 : 0;
        } catch (err) {
          log.warn("在途作业对账失败，下轮重试", { jobId: j.id, error: err instanceof Error ? err.message.slice(0, 200) : String(err) });
        }
      }
    }
    // 4. 费用账本：已终结作业的待结算行（回执此前不可读）
    if (this.d.fees) await this.d.fees.settlePending().catch((err) => log.warn("费用账本补结算失败", { error: err instanceof Error ? err.message.slice(0, 200) : String(err) }));
    void now;
    return { created, moved };
  }

  private async reconcileStepJob(j: JobRow, head: { number: bigint; timestamp: bigint }): Promise<boolean> {
    const chain = this.d.chain!;
    const step = j.stepId ? await this.d.mandates.stepById(j.stepId) : null;
    const m = j.mandateId ? await this.d.mandates.byId(j.mandateId) : null;
    if (!step || !m) return false;
    if (step.state === "CONFIRMED") return !!(await this.move(j, "CONFIRMED"));
    const hash = (j.txHash ?? j.rawTxHash) as Hex | null;
    const rcpt = hash ? await chain.getReceipt(hash).catch(() => null) : null;
    const st = await chain.mandateState(m.planGuardAddress as Hex, m.mandateDigest as Hex);
    const verdict = reconcileStep({ stepIndex: step.stepIndex, signedValidUntil: MandatesService.signedValidUntil(step), chainHeadTs: Number(head.timestamp), chainSteps: st.steps, receipt: rcpt ? { status: rcpt.status, confirmations: Number(head.number - rcpt.blockNumber + 1n) } : null, confirmationsRequired: this.d.cfg.RECEIPT_CONFIRMATIONS, marginS: this.d.cfg.EXECUTION_EXPIRY_MARGIN_S });
    if (verdict === "REVERTED") return !!(await this.move(j, "REVERTED", { errorCode: "reverted" }, { code: "reverted" }));
    if (verdict === "EXECUTED_ELSEWHERE") {
      await this.d.mandates.backfillMandate(m);
      const s2 = await this.d.mandates.stepById(step.id);
      if (s2?.state === "CONFIRMED") return !!(await this.move(j, "CONFIRMED"));
      if (s2?.state === "SUPERSEDED") return !!(await this.move(j, "EXPIRED", { errorCode: "executed_by_other_certificate" }, { code: "executed_by_other_certificate" }));
      return false;
    }
    if (verdict === "EXPIRED") {
      // 过了签名 validUntil + margin 且链上步序没动：这一步确定没有执行
      await this.d.db.update(verifyMandateSteps).set({ state: "EXPIRED", updatedAt: this.now() }).where(and(eq(verifyMandateSteps.id, step.id), inArray(verifyMandateSteps.state, ["PREPARED", "SUBMITTED", "UNKNOWN"])));
      return !!(await this.move(j, "EXPIRED", { errorCode: "not_mined_before_expiry" }, { cls: "retry_new_cert", code: "not_mined_before_expiry" }));
    }
    // CONFIRMED_BY_RECEIPT / WAIT：交给回执核实器（6 确认 + 事件归因），确认后经 onStepState 结束作业
    return false;
  }

  /** permit 在途：有回执按回执；无回执且 nonce 已前进（被他人抢先上链）→ 额度 ≥ value 视为确认，否则 FAILED permit_nonce_consumed */
  private async reconcilePermit(j: JobRow, _head: { number: bigint; timestamp: bigint }): Promise<void> {
    const chain = this.d.chain!;
    const p = j.payloadJson as PermitJobPayload;
    if (j.txHash) {
      const r = await chain.getReceipt(j.txHash as Hex).catch(() => null);
      if (r) return this.checkPermitReceipt(j);
    }
    const nonce = await chain.nonces(p.token, p.owner);
    if (nonce <= BigInt(p.nonce)) {
      if (BigInt(p.deadline) < BigInt(this.nowSec())) {
        const u = await this.move(j, "EXPIRED", { errorCode: "permit_deadline_passed" }, { code: "permit_deadline_passed" });
        if (u) await this.d.onPermitResult?.(p.permitId, false, { txHash: j.txHash, allowanceAfter: null, code: "permit_deadline_passed" });
      }
      return;
    }
    const allowance = await chain.allowance(p.token, p.owner, p.spender);
    if (allowance >= BigInt(p.value)) {
      const u = await this.move(j, "CONFIRMED", { resultJson: { frontRun: true } });
      if (u) await this.d.onPermitResult?.(p.permitId, true, { txHash: j.txHash, allowanceAfter: allowance.toString(), code: null });
    } else {
      const u = await this.move(j, "FAILED", { errorCode: "permit_nonce_consumed" }, { code: "permit_nonce_consumed" });
      if (u) await this.d.onPermitResult?.(p.permitId, false, { txHash: j.txHash, allowanceAfter: allowance.toString(), code: "permit_nonce_consumed" });
    }
  }

  /** 运营者状态：队列计数 */
  async queueCounts(): Promise<Record<string, number>> {
    const rows = await this.d.db.select({ state: verifyExecutionJobs.state, kind: verifyExecutionJobs.kind }).from(verifyExecutionJobs).where(inArray(verifyExecutionJobs.state, ["QUEUED", "CLAIMED", "SENDING", "SENT"]));
    const out: Record<string, number> = {};
    for (const r of rows) out[`${r.kind}:${r.state}`] = (out[`${r.kind}:${r.state}`] ?? 0) + 1;
    return out;
  }
}

/** 纵深防御：permit 作业的 raw tx 若可解析，解码后的 owner / spender 必须与作业一致（执行者侧白名单之外再查一次） */
export function permitCalldataMatches(data: Hex, p: PermitJobPayload): boolean {
  const d = decodePermitCalldata(data);
  return !!d && d.owner.toLowerCase() === p.owner.toLowerCase() && d.spender.toLowerCase() === p.spender.toLowerCase() && d.value.toString() === p.value;
}

