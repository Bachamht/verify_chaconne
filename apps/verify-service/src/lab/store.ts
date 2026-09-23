/**
 * Lane E 落库：verify_policy_comparisons / verify_replays（Drizzle 定义在 packages/db verifySchema.ts「v6 Lane E」块）。
 * 迁移由 Lane I 合并进 0018；合并前测试与演示用下面的 DDL 建表（与 Drizzle 定义逐列一致）。
 */
import { eq, sql } from "drizzle-orm";
import type { Db } from "@chaconne/db";
import { verifyPolicyComparisons, verifyReplays } from "@chaconne/db";

export const LAB_TABLES_DDL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS "verify_policy_comparisons" (
    "id" text PRIMARY KEY NOT NULL,
    "caller_id" text NOT NULL,
    "owner_address" text NOT NULL,
    "task_id" text NOT NULL,
    "evidence_snapshot_id" text NOT NULL,
    "snapshot_hash" text NOT NULL,
    "comparison_json" jsonb NOT NULL,
    "result_json" jsonb NOT NULL,
    "evaluator_id" text NOT NULL,
    "mode" text DEFAULT 'SIMULATION' NOT NULL,
    "created_at" timestamp with time zone NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS "verify_policy_comparisons_task_idx" ON "verify_policy_comparisons" ("task_id","created_at")`,
  `CREATE TABLE IF NOT EXISTS "verify_replays" (
    "id" text PRIMARY KEY NOT NULL,
    "caller_id" text NOT NULL,
    "owner_address" text,
    "asset_key" text NOT NULL,
    "playbook_id" text NOT NULL,
    "conditions_hash" text NOT NULL,
    "from_at" timestamp with time zone NOT NULL,
    "to_at" timestamp with time zone NOT NULL,
    "run_json" jsonb NOT NULL,
    "result_json" jsonb NOT NULL,
    "evaluator_id" text NOT NULL,
    "mode" text DEFAULT 'REPLAY' NOT NULL,
    "created_at" timestamp with time zone NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS "verify_replays_caller_idx" ON "verify_replays" ("caller_id","created_at")`,
];

/** 建表（幂等）：仅测试 / 本地演示用；生产走迁移 0018 */
export async function ensureLabTables(db: Db): Promise<void> {
  for (const ddl of LAB_TABLES_DDL) await db.execute(sql.raw(ddl));
}

export type ComparisonRow = typeof verifyPolicyComparisons.$inferSelect;
export type ReplayRow = typeof verifyReplays.$inferSelect;

export class LabStore {
  constructor(private readonly db: Db) {}

  async saveComparison(row: typeof verifyPolicyComparisons.$inferInsert): Promise<ComparisonRow> {
    // 同内容派生同 id：重复对照直接返回既有行（可复算、不重复落库）
    const existing = await this.getComparison(row.id);
    if (existing) return existing;
    const [r] = await this.db.insert(verifyPolicyComparisons).values(row).returning();
    return r!;
  }
  async getComparison(id: string): Promise<ComparisonRow | null> {
    return (await this.db.select().from(verifyPolicyComparisons).where(eq(verifyPolicyComparisons.id, id)).limit(1))[0] ?? null;
  }
  async saveReplay(row: typeof verifyReplays.$inferInsert): Promise<ReplayRow> {
    const [r] = await this.db.insert(verifyReplays).values(row).returning();
    return r!;
  }
  async getReplay(id: string): Promise<ReplayRow | null> {
    return (await this.db.select().from(verifyReplays).where(eq(verifyReplays.id, id)).limit(1))[0] ?? null;
  }
}
