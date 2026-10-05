/**
 * v7 作业终结后的处理（开发计划 §2.5 自动重签 + 失败分类表）：
 *   retry_new_cert（证书过期 / 剩余不足 / 发送前过期）→ 同一意图自动重签一次（AUTO_RECERTIFY_MAX，意图创建后 AUTO_RECERTIFY_WINDOW_S 内），
 *       新报价重新过四道核验；签发闸门仍在途（被取走的证书未过签名 validUntil + margin）时等下一轮再试；
 *   价格类（replan）/ 流动性 / 其它 → 不重签；时间线 execution_failed + 通知 task.execution_failed（Lane A 据此开 execution_failed 轮次）；
 *   scope / bug → integrity_alert（服务侧核验漏网 = 缺陷）；chain_ahead → 已在作业仓储里跑链上回填。
 * D-089 修订（运营者确认 2026-10-02）：
 *   连续失败暂停：同一 (授权, 步序) 在当前意图下已有 N 次付费失败（广播过的作业以 REVERTED / EXPIRED / FAILED 结束，
 *       EXECUTION_PAID_FAILURE_PAUSE_N，缺省 2）→ 不再自动重签换新交易，直接开 execution_failed 轮次交回 Agent；Agent 的新意图重新计数。
 *       崩溃恢复时查询或原样重播同一笔已签名交易不产生新作业，不计入。
 *   费用护栏（fee_budget_exhausted / fee_cap_exceeded）→ 交易没有发出：不开 Agent 轮次、不让 owner 签名，时间线如实写明、needsOperator、运营者告警。
 */
import { and, eq, gte, inArray, isNotNull, or } from "drizzle-orm";
import type { Db } from "@chaconne/db";
import { verifyExecutionJobs, verifyTaskIntents } from "@chaconne/db";
import type { VerifyConfig } from "../config";
import { log } from "../log";
import { appendTimeline } from "../records/timeline";
import { notificationPayload } from "../tasks/notify";
import type { TasksService } from "../tasks/service";
import type { JobTerminalInfo } from "./jobs";
import type { OpsState } from "./ops";
import { FEE_OPERATOR_CODES, type FeeBudget } from "./fees";

export class JobOutcomeHandler {
  /** intentId → 第一次排队时间（ms） */
  private readonly pending = new Map<string, number>();
  constructor(private readonly d: { db: Db; cfg: VerifyConfig; tasks: TasksService; ops: OpsState; fees?: FeeBudget | null; now?: () => Date; onExecutionFailed?: (taskId: string, info: { jobId: string; intentId?: string | null; errorCode?: string | null; revertClass?: string | null; consecutivePaidFailures?: number; autoRetryPaused?: boolean }) => Promise<unknown> }) {}
  private now(): Date {
    return this.d.now ? this.d.now() : new Date();
  }
  pendingIntents(): string[] {
    return [...this.pending.keys()];
  }

  async onTerminal(info: JobTerminalInfo): Promise<void> {
    const j = info.job;
    if (j.kind !== "execute_step" || !j.taskId) return;
    if (info.state === "CONFIRMED" || info.state === "CANCELLED") return;
    const intent = (await this.d.db.select().from(verifyTaskIntents).where(eq(verifyTaskIntents.jobId, j.id)).limit(1))[0] ?? null;
    const cls = info.cls;
    const nowMs = this.now().getTime();
    if (info.code && FEE_OPERATOR_CODES.has(info.code)) return this.feeBlocked(j.taskId, j.id, info.code, intent?.id ?? null);
    // 连续付费失败暂停（当前意图下同一步）：达到 N 次后不再自动换新交易，交回 Agent
    const paid = await this.paidFailures(j.mandateId, j.stepIndex, intent?.createdAt ?? null);
    const paused = paid >= this.d.cfg.EXECUTION_PAID_FAILURE_PAUSE_N;
    if (paused) {
      await appendTimeline(this.d.db, j.taskId, { at: this.now().toISOString(), type: "execution_retry_paused", ref: j.id, note: `${paid} consecutive paid attempts for this step failed (${info.code ?? cls ?? "unknown"}): automatic re-signing is paused; the agent must re-check the quote, allowance and strategy and submit a new intent`, data: { jobId: j.id, intentId: intent?.id ?? null, consecutivePaidFailures: paid, cls } }, "system");
      return this.executionFailed(j.taskId, j.id, info.state, cls, info.code, intent?.id ?? null, { consecutivePaidFailures: paid, autoRetryPaused: true });
    }
    if (cls === "retry_new_cert" && intent && intent.attempts - 1 < this.d.cfg.AUTO_RECERTIFY_MAX && nowMs - intent.createdAt.getTime() <= this.d.cfg.AUTO_RECERTIFY_WINDOW_S * 1000) {
      this.pending.set(intent.id, nowMs);
      await appendTimeline(this.d.db, j.taskId, { at: this.now().toISOString(), type: "execution_retrying", ref: j.id, note: `job ${j.id} ${info.state} (${info.code ?? cls}): re-certifying the same intent with a fresh quote`, data: { jobId: j.id, intentId: intent.id, cls } }, "executor:hosted");
      return;
    }
    if (cls === "scope" || cls === "bug") this.d.ops.alert("integrity_alert", { taskId: j.taskId, mandateId: j.mandateId, detail: `job ${j.id} ${info.state}: ${info.code ?? cls} (${cls}) — a service-side check missed this` });
    await this.executionFailed(j.taskId, j.id, info.state, cls, info.code, intent?.id ?? null);
  }

  /**
   * 同一 (授权, 步序) 自 since（当前意图创建时刻；新意图 = 重新计数）以来的付费失败数：
   * 作业到过发送提交点（raw_tx_hash / tx_hash 非空 = 签过名、可能已广播、可能已扣费）且以 REVERTED / EXPIRED / FAILED 结束。
   * 崩溃恢复重播同一笔交易不产生新作业，所以不会被重复计数。
   */
  async paidFailures(mandateId: string | null, stepIndex: number | null, since: Date | null): Promise<number> {
    if (!mandateId || stepIndex === null) return 0;
    const rows = await this.d.db
      .select({ id: verifyExecutionJobs.id })
      .from(verifyExecutionJobs)
      .where(and(eq(verifyExecutionJobs.mandateId, mandateId), eq(verifyExecutionJobs.stepIndex, stepIndex), inArray(verifyExecutionJobs.state, ["REVERTED", "EXPIRED", "FAILED"]), or(isNotNull(verifyExecutionJobs.rawTxHash), isNotNull(verifyExecutionJobs.txHash)), ...(since ? [gte(verifyExecutionJobs.createdAt, since)] : [])));
    return rows.length;
  }

  /** 费用护栏挡下（交易没有发出）：如实告知 owner，运营者处理；不开 Agent 轮次 */
  private async feeBlocked(taskId: string, jobId: string, code: string, intentId: string | null): Promise<void> {
    const at = this.now().toISOString();
    const why = code === "fee_budget_exhausted" ? "the platform's transaction-fee budget for this wallet, task or day is used up" : "network fees are above the platform's per-transaction fee cap";
    const tl = await appendTimeline(this.d.db, taskId, { at, type: "execution_blocked_fee", ref: jobId, note: `not sent: ${why}. Nothing was broadcast and no gas was spent; nothing for you to sign — the operator has been notified. Your signed scope is unchanged.`, data: { jobId, code, intentId } }, "system");
    this.d.ops.alert(code, { taskId, detail: `job ${jobId}: ${code}` });
    await this.d.fees?.alertOperator(code, `task ${taskId} job ${jobId}: ${code}`);
    const row = tl.row ?? (await this.d.tasks.byId(taskId));
    if (row) await this.d.tasks.deps.notifier.emit(notificationPayload("task.execution_failed", taskId, tl.ids[0] ?? 0, `not sent (${code}): the platform is handling it; nothing for you to sign`, `/agent/tasks/${taskId}`, at), row.ownerAddress);
  }

  private async executionFailed(taskId: string, jobId: string, state: string, cls: string | null, code: string | null, intentId: string | null, extra: { consecutivePaidFailures?: number; autoRetryPaused?: boolean } = {}): Promise<void> {
    const at = this.now().toISOString();
    const tl = await appendTimeline(this.d.db, taskId, { at, type: "execution_failed", ref: jobId, note: `execution ${state.toLowerCase()}: ${code ?? "unknown"}${cls ? ` (${cls})` : ""}${extra.autoRetryPaused ? `; automatic retries paused after ${extra.consecutivePaidFailures} paid failures` : ""}`, data: { jobId, state, cls, code, intentId, ...extra } }, "executor:hosted");
    const row = tl.row ?? (await this.d.tasks.byId(taskId));
    // Lane A：execution_failed 轮次（自动重签没有消化的失败才到这里）
    await this.d.onExecutionFailed?.(taskId, { jobId, intentId, errorCode: code, revertClass: cls, ...extra }).catch((err) => log.warn("onExecutionFailed 失败", { taskId, error: err instanceof Error ? err.message : String(err) }));
    if (row) await this.d.tasks.deps.notifier.emit(notificationPayload("task.execution_failed", taskId, tl.ids[0] ?? 0, `execution ${state.toLowerCase()} (${cls ?? code ?? "unknown"})`, `/agent/tasks/${taskId}`, at), row.ownerAddress);
  }

  /** 清扫器每轮调用：闸门放行时对排队的意图重签；超出时间窗 → execution_failed */
  async tick(): Promise<number> {
    let done = 0;
    for (const [intentId, queuedAt] of [...this.pending]) {
      const intent = (await this.d.db.select().from(verifyTaskIntents).where(eq(verifyTaskIntents.id, intentId)).limit(1))[0];
      if (!intent || intent.status !== "certified") {
        this.pending.delete(intentId);
        continue;
      }
      const nowMs = this.now().getTime();
      if (nowMs - intent.createdAt.getTime() > this.d.cfg.AUTO_RECERTIFY_WINDOW_S * 1000) {
        this.pending.delete(intentId);
        await this.executionFailed(intent.taskId, intent.jobId ?? "", "EXPIRED", "retry_new_cert", "recertify_window_passed", intentId);
        continue;
      }
      const step = intent.stepJson as { mandateId?: string } | null;
      const mandate = step?.mandateId ? await this.d.tasks.deps.mandates.byId(step.mandateId) : null;
      if (!mandate) {
        this.pending.delete(intentId);
        continue;
      }
      const gate = await this.d.tasks.deps.mandates.issuanceGateFor(mandate);
      if (gate.action === "wait") continue;
      if (gate.action === "backfill") {
        await this.d.tasks.deps.mandates.backfillMandate(mandate).catch(() => undefined);
        continue;
      }
      this.pending.delete(intentId);
      try {
        const r = await this.d.tasks.intents.recertify(intentId);
        done += 1;
        const st = (r.body["intent"] as { status?: string } | undefined)?.status;
        if (st !== "certified") await this.executionFailed(intent.taskId, intent.jobId ?? "", "FAILED", "retry_new_cert", "recertify_rejected", intentId);
        else {
          const row = await this.d.tasks.byId(intent.taskId);
          if (row) await this.d.tasks.deps.notifier.emit(notificationPayload("task.recertified", intent.taskId, Math.floor(nowMs / 1000), `intent ${intentId} re-certified automatically (fresh quote, four checks passed again)`, `/agent/tasks/${intent.taskId}`, this.now().toISOString()), row.ownerAddress);
        }
      } catch (err) {
        log.warn("自动重签失败", { intentId, queuedAt, error: err instanceof Error ? err.message.slice(0, 200) : String(err) });
        await this.executionFailed(intent.taskId, intent.jobId ?? "", "FAILED", "retry_new_cert", "recertify_error", intentId);
      }
    }
    return done;
  }
}
