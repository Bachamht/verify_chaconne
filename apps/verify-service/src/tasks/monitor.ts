/**
 * 任务 monitor（开发计划 §3.2）：每 tick 对 ACTIVE/WAITING/STEP_PREPARED/PARTIAL/PAUSED 任务求值；
 * 阻塞集合变化才写 verify_task_blockers 与发 task.blocked（在 TasksService.evaluateTask 里）；nextCheckAt 写回；PAUSED 仍评估不签发。
 * 挂到 mandates monitor 的同一个 tick（mandates/monitor.ts monitorOnce(mandates, tasks)）。
 */
import { log } from "../log";
import { scopeOf, type TasksService } from "./service";
import type { Db } from "../db";
import { confirmRevocationsOnce, type RevokedLogReader } from "./revocations";

export async function taskMonitorOnce(tasks: TasksService, revocations?: { db: Db; reader: RevokedLogReader } | null): Promise<{ checked: number; issued: number; waiting: number; expired: number; revoked?: number }> {
  const expired = await tasks.expireTasks();
  // 链上撤销确认（D-088）：只认 MandateRevoked 日志，按钮响应从不算撤销完成
  const rev = revocations ? await confirmRevocationsOnce(tasks, revocations.db, revocations.reader) : null;
  const rows = await tasks.monitoredTasks();
  let issued = 0;
  let waiting = 0;
  for (const row of rows) {
    try {
      // CV-D16：scope.issuance=agent 的任务只评估不签发（签发只跟着 agent 提交的交易意图走）
      const r = await tasks.evaluateTask(row, { issue: row.status !== "PAUSED" && scopeOf(row)?.issuance !== "agent" });
      if (r.status === "STEP_PREPARED") issued += 1;
      if (r.status === "WAITING") waiting += 1;
    } catch (err) {
      log.warn("任务评估失败", { taskId: row.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (rows.length > 0) log.info("task monitor 轮次", { checked: rows.length, issued, waiting, expired });
  return { checked: rows.length, issued, waiting, expired, ...(rev ? { revoked: rev.confirmed } : {}) };
}
