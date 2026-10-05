/**
 * v7 R1 · 任务时间线（开发计划 §3.6 R1，interfaces §12.11 `verify_task_timeline`）。
 *
 * 事实来源 = `verify_task_timeline`（每条一行，带 actor，不裁剪）；`verify_tasks.timeline_json` 只是最近 200 条的兼容缓存
 * （旧页面 / 旧证据包 / 旧 MCP 摘要还在读它）。所有写时间线的地方都必须走 `appendTimeline`：
 *   - 同一事务里插入行 + 原子地把条目追加进缓存并裁到 200 条（SQL 内完成，不再读-改-写，杜绝并发覆盖）；
 *   - 返回更新后的任务行与新行 id（id 单调递增，可作通知幂等序号与活动流游标）。
 *
 * actor 映射（§3.6）：`web:<owner>` / `a2mcp:owner:<owner>` → owner；`agent:<钱包>` → agent:byo；`agent:hosted`；`executor:hosted`；
 * 内部（monitor、回执核实器、通知渠道、轮次调度）→ system；其它 API key 调用方（配置表里的 key，自带 Agent）→ agent:byo。
 */
import { eq, sql } from "drizzle-orm";
import type { Db } from "@chaconne/db";
import { verifyTaskTimeline, verifyTasks } from "@chaconne/db";
import type { Actor } from "@chaconne/core/verify";

/** 兼容缓存的条数上限（旧 `.slice(-200)` 语义） */
export const TIMELINE_CACHE_MAX = 200;

/** 一条时间线（缓存里的形状 = 旧 TimelineEntry；data 只进 data_json，不进缓存） */
export interface TimelineInput {
  at: string;
  type: string;
  from?: string;
  to?: string;
  note?: string;
  ref?: string;
  /** 结构化附加字段（只放字符串 / 安全整数 / 布尔；canon-1 不允许浮点） */
  data?: Record<string, unknown>;
}

export const ACTORS: readonly Actor[] = ["owner", "agent:hosted", "agent:byo", "executor:hosted", "system"];

/** callerId → Actor；null / "system" / 内部调用 → system */
export function actorOf(callerId: string | null | undefined): Actor {
  if (!callerId || callerId === "system") return "system";
  const c = callerId.toLowerCase();
  if (c === "agent:hosted") return "agent:hosted";
  if (c === "executor:hosted") return "executor:hosted";
  if ((ACTORS as readonly string[]).includes(c)) return c as Actor;
  if (/^web:0x[0-9a-f]{40}$/.test(c) || /^a2mcp:owner:0x[0-9a-f]{40}$/.test(c) || /^0x[0-9a-f]{40}$/.test(c)) return "owner";
  if (/^agent:0x[0-9a-f]{40}$/.test(c)) return "agent:byo";
  if (c.startsWith("system:") || c.startsWith("internal:")) return "system";
  return "agent:byo";
}

function cacheEntry(e: TimelineInput): Record<string, string> {
  const out: Record<string, string> = { at: e.at, type: e.type };
  if (e.from !== undefined) out["from"] = e.from;
  if (e.to !== undefined) out["to"] = e.to;
  if (e.note !== undefined) out["note"] = e.note;
  if (e.ref !== undefined) out["ref"] = e.ref;
  return out;
}

/** data_json 只保留 canon-1 可哈希的值（字符串 / 安全整数 / 布尔 / null / 嵌套）；其它数值转十进制串 */
export function canonSafe(v: unknown): unknown {
  if (v === null || typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isSafeInteger(v) ? v : String(v);
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : canonSafe(x)));
  if (typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (x !== undefined) out[k] = canonSafe(x);
    return out;
  }
  return null;
}

export type TaskRowT = typeof verifyTasks.$inferSelect;

/**
 * 追加时间线：插入 verify_task_timeline（不裁剪、带 actor）+ 原子追加兼容缓存（最近 200 条）。
 * 任务不存在时只返回 { row: undefined, ids: [] }（不写孤儿行）。
 */
export async function appendTimeline(db: Db, taskId: string, entries: TimelineInput | TimelineInput[], actor: Actor): Promise<{ row: TaskRowT | undefined; ids: number[] }> {
  const list = Array.isArray(entries) ? entries : [entries];
  if (list.length === 0) return { row: (await db.select().from(verifyTasks).where(eq(verifyTasks.id, taskId)).limit(1))[0], ids: [] };
  const cache = JSON.stringify(list.map(cacheEntry));
  return db.transaction(async (tx) => {
    const merged = sql`(COALESCE(${verifyTasks.timelineJson}, '[]'::jsonb) || ${cache}::jsonb)`;
    const [row] = await tx
      .update(verifyTasks)
      .set({
        timelineJson: sql`(SELECT COALESCE(jsonb_agg(e.value ORDER BY e.ord), '[]'::jsonb) FROM jsonb_array_elements(${merged}) WITH ORDINALITY AS e(value, ord) WHERE e.ord > jsonb_array_length(${merged}) - ${TIMELINE_CACHE_MAX})`,
      })
      .where(eq(verifyTasks.id, taskId))
      .returning();
    if (!row) return { row: undefined, ids: [] };
    const inserted = await tx
      .insert(verifyTaskTimeline)
      .values(list.map((e) => ({ taskId, at: new Date(e.at), actor, type: e.type, ref: e.ref ?? null, note: e.note ?? null, dataJson: canonSafe({ ...cacheEntry(e), ...(e.data ?? {}) }) as Record<string, unknown> })))
      .returning({ id: verifyTaskTimeline.id });
    return { row, ids: inserted.map((r) => r.id) };
  });
}
