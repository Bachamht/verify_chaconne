/**
 * Recap 数据源：v5 授权计划表（verify_mandates / evaluations / steps）是当下真实可用的账目来源；
 * v6 任务（Lane B）与事件（Lane D）以可选钩子接入——未接上时 coverage 标 unavailable，不伪装。
 */
import { and, eq, gte, inArray, lt } from "drizzle-orm";
import type { Db } from "@chaconne/db";
import { verifyMandateEvaluations, verifyMandateSteps, verifyMandates } from "@chaconne/db";
import type { MarketEvent, Task } from "@chaconne/core/verify";

export interface MandateBundle {
  row: typeof verifyMandates.$inferSelect;
  evaluations: Array<typeof verifyMandateEvaluations.$inferSelect>;
  steps: Array<typeof verifyMandateSteps.$inferSelect>;
}

export interface RecapSources {
  /** 只返回 callerId + owner 都匹配的授权计划（owner 鉴权与既有任务隔离一致） */
  mandatesForOwner(callerId: string, owner: string, dayStartUtc: Date, dayEndUtc: Date): Promise<MandateBundle[]>;
  /** Lane B 任务；未接上返回 null */
  tasksForOwner?: (callerId: string, owner: string) => Promise<Task[] | null>;
  /** Lane D 事件；未接上返回 null */
  eventsBetween?: (fromUtc: Date, toUtc: Date) => Promise<MarketEvent[] | null>;
  /** 证据模式（LIVE / FIXTURE） */
  evidenceMode: () => "LIVE" | "FIXTURE";
}

export function dbRecapSources(db: Db, evidenceMode: () => "LIVE" | "FIXTURE", hooks: Pick<RecapSources, "tasksForOwner" | "eventsBetween"> = {}): RecapSources {
  return {
    evidenceMode,
    ...hooks,
    async mandatesForOwner(callerId, owner, dayStartUtc, dayEndUtc) {
      const rows = await db.select().from(verifyMandates).where(and(eq(verifyMandates.callerId, callerId), eq(verifyMandates.ownerAddress, owner.toLowerCase())));
      // 只取与本交易日有关的授权：当日仍有效（deadline ≥ 日起）且在日终前已创建
      const relevant = rows.filter((r) => r.deadline.getTime() >= dayStartUtc.getTime() && r.createdAt.getTime() < dayEndUtc.getTime());
      if (relevant.length === 0) return [];
      const ids = relevant.map((r) => r.id);
      const evaluations = await db
        .select()
        .from(verifyMandateEvaluations)
        .where(and(inArray(verifyMandateEvaluations.mandateId, ids), gte(verifyMandateEvaluations.evaluatedAt, dayStartUtc), lt(verifyMandateEvaluations.evaluatedAt, dayEndUtc)));
      const steps = await db.select().from(verifyMandateSteps).where(inArray(verifyMandateSteps.mandateId, ids));
      return relevant.map((row) => ({ row, evaluations: evaluations.filter((e) => e.mandateId === row.id), steps: steps.filter((s) => s.mandateId === row.id) }));
    },
  };
}
