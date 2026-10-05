/**
 * 任务证据（verify_task_evidence，CV-D23）：agent-context 与 quotes 返回的证据写到这里，15 分钟内可被意图的 platform_fact 引用并核对。
 */
import { and, eq, gte } from "drizzle-orm";
import type { Db } from "@chaconne/db";
import { verifyTaskEvidence } from "@chaconne/db";
import { TASK_EVIDENCE_TTL_MS, type EvidenceRecord, type TaskEvidenceIndex } from "@chaconne/core/verify";

/** 证据记录的数据观察时刻：上游源时间优先，否则收到响应的时刻 */
export function observedAtOf(r: EvidenceRecord): string {
  return r.time.sourcePublishedAt ?? r.time.receivedAt;
}

/** 写入（同一 evidenceId 再次看到 → 刷新登记时刻） */
export async function recordTaskEvidence(db: Db, taskId: string, source: "agent_context" | "quotes", records: readonly EvidenceRecord[], now: Date): Promise<void> {
  for (const r of records) {
    await db
      .insert(verifyTaskEvidence)
      .values({ taskId, evidenceId: r.evidenceId, kind: r.payload.kind, source, recordJson: r, createdAt: now })
      .onConflictDoUpdate({ target: [verifyTaskEvidence.taskId, verifyTaskEvidence.evidenceId], set: { createdAt: now } });
  }
}

/** 该任务 15 分钟内登记过的证据索引（给 triageClaims 用） */
export async function taskEvidenceIndex(db: Db, taskId: string, now: Date): Promise<TaskEvidenceIndex> {
  const rows = await db.select().from(verifyTaskEvidence).where(and(eq(verifyTaskEvidence.taskId, taskId), gte(verifyTaskEvidence.createdAt, new Date(now.getTime() - TASK_EVIDENCE_TTL_MS))));
  return new Map(rows.map((r) => [r.evidenceId, { observedAt: observedAtOf(r.recordJson as EvidenceRecord), seenAt: r.createdAt.toISOString() }]));
}
