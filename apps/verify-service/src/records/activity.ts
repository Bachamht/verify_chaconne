/**
 * v7 R2 / R5 · 时间线分页、活动流、公开值守看板（开发计划 §2.8、§3.6 R2 / R5，P-07 / R-06）。
 *
 * - 时间线：`verify_task_timeline` 按 id 升序分页，`cursor` = 上一页最后一行的 id（不含）。
 * - 活动流：同一张表的增量查询，`since` = 上次拿到的 `nextCursor`；不带 since 时给最近 limit 条（仍按 id 升序）。
 *   轮次工具调用（actor agent:hosted）与执行作业状态（actor executor:hosted）由 Lane A / X 经 appendTimeline 写进同一张表。
 * - 公开看板：只输出 **类别 + 时间 + 操作者类别**；不含金额、数量、地址、任何 id 或自由文本（note / ref / data 一律不出）。
 */
import { and, asc, desc, eq, gt } from "drizzle-orm";
import type { Db } from "@chaconne/db";
import { verifyTaskTimeline } from "@chaconne/db";
import type { Actor } from "@chaconne/core/verify";

export type TimelineRow = typeof verifyTaskTimeline.$inferSelect;

export interface TimelineItem {
  id: number;
  at: string;
  actor: Actor;
  type: string;
  ref: string | null;
  note: string | null;
  from?: string;
  to?: string;
  data: Record<string, unknown> | null;
}

export const TIMELINE_PAGE_DEFAULT = 100;
export const TIMELINE_PAGE_MAX = 500;
export const ACTIVITY_PAGE_DEFAULT = 50;
export const ACTIVITY_PAGE_MAX = 200;

export function itemOf(r: TimelineRow): TimelineItem {
  const data = (r.dataJson as Record<string, unknown> | null) ?? null;
  const item: TimelineItem = { id: r.id, at: r.at.toISOString(), actor: r.actor as Actor, type: r.type, ref: r.ref ?? null, note: r.note ?? null, data };
  if (data && typeof data["from"] === "string") item.from = data["from"];
  if (data && typeof data["to"] === "string") item.to = data["to"];
  return item;
}

/** 解析游标 / 条数：非法值 → null（调用方回 400） */
export function parseCursor(v: unknown): number | null | undefined {
  if (v === undefined || v === "") return undefined;
  if (typeof v !== "string" || !/^\d{1,15}$/.test(v)) return null;
  return Number(v);
}
export function parseLimit(v: unknown, def: number, max: number): number | null {
  if (v === undefined || v === "") return def;
  if (typeof v !== "string" || !/^\d{1,4}$/.test(v)) return null;
  const n = Number(v);
  if (n < 1) return null;
  return Math.min(n, max);
}

/** 全量时间线分页（id 升序）；nextCursor = 还有下一页时本页最后一行的 id，否则 null */
export async function timelinePage(db: Db, taskId: string, cursor: number | undefined, limit: number): Promise<{ items: TimelineItem[]; nextCursor: string | null }> {
  const rows = await db
    .select()
    .from(verifyTaskTimeline)
    .where(cursor === undefined ? eq(verifyTaskTimeline.taskId, taskId) : and(eq(verifyTaskTimeline.taskId, taskId), gt(verifyTaskTimeline.id, cursor)))
    .orderBy(asc(verifyTaskTimeline.id))
    .limit(limit + 1);
  const more = rows.length > limit;
  const page = more ? rows.slice(0, limit) : rows;
  return { items: page.map(itemOf), nextCursor: more ? String(page.at(-1)!.id) : null };
}

/**
 * 活动流：since 之后的新条目（id 升序，最多 limit 条）；不带 since → 最近 limit 条。
 * nextCursor 永远可直接作为下一次的 since（没有新条目时原样返回 since）；hasMore = 本次没取完。
 */
export async function activityPage(db: Db, taskId: string, since: number | undefined, limit: number): Promise<{ items: TimelineItem[]; nextCursor: string | null; hasMore: boolean }> {
  if (since === undefined) {
    const rows = await db.select().from(verifyTaskTimeline).where(eq(verifyTaskTimeline.taskId, taskId)).orderBy(desc(verifyTaskTimeline.id)).limit(limit);
    const items = rows.reverse().map(itemOf);
    return { items, nextCursor: items.length ? String(items.at(-1)!.id) : null, hasMore: false };
  }
  const p = await timelinePage(db, taskId, since, limit);
  return { items: p.items, nextCursor: p.items.length ? String(p.items.at(-1)!.id) : String(since), hasMore: p.nextCursor !== null };
}

/** 全部行（证据包 / 夜班日志用；按 id 升序） */
export async function allTimelineRows(db: Db, taskId: string): Promise<TimelineRow[]> {
  return db.select().from(verifyTaskTimeline).where(eq(verifyTaskTimeline.taskId, taskId)).orderBy(asc(verifyTaskTimeline.id));
}

/* ---------------- 公开看板（R5 / P-07） ---------------- */

export const ACTIVITY_CATEGORIES = ["task", "authorization", "decision", "wait", "trade", "execution", "data", "fault", "recovery", "owner_action", "other"] as const;
export type ActivityCategory = (typeof ACTIVITY_CATEGORIES)[number];

/** 时间线 type → 公开类别（白名单映射；未知 type 一律 other，不泄露原始 type 名之外的任何内容） */
export function categoryOf(type: string): ActivityCategory {
  if (type === "created" || type === "status" || type === "archived") return "task";
  if (type === "authorized" || type.startsWith("permit") || type.startsWith("delegation") || type === "allowance_confirmed" || type === "revoked") return "authorization";
  if (type === "intent_certified" || type === "intent_simulated" || type === "intent_rejected" || type === "intent_withdrawn" || type === "agent_plan_revised" || type === "agent_accepted" || type === "agent_ended" || type === "agent_declined" || type === "run_completed" || type === "agent_tool" || type === "agent_turn") return "decision";
  if (type === "agent_waiting" || type === "agent_needs_evidence" || type === "agent_no_response" || type === "waiting") return "wait";
  if (type === "step_confirmed" || type === "sell_confirmed") return "trade";
  if (type.startsWith("job_") || type === "execution_sent" || type === "execution_sending") return "execution";
  if (type === "data_arrived" || type.startsWith("event")) return "data";
  if (type === "execution_failed" || type.endsWith("_failed") || type === "integrity_alert" || type.startsWith("channel_") || type.startsWith("delivery_")) return "fault";
  if (type === "recertified" || type === "recovered" || type === "receipt_recovered") return "recovery";
  if (type === "brief_updated" || type === "conditions_changed" || type === "exit_draft" || type === "handover") return "owner_action";
  return "other";
}

/** 操作者的公开类别（Actor 本身就是枚举，不含地址） */
export function publicActor(a: string): "owner" | "agent" | "executor" | "system" {
  if (a === "owner") return "owner";
  if (a.startsWith("agent")) return "agent";
  if (a.startsWith("executor")) return "executor";
  return "system";
}

export interface PublicActivityItem {
  at: string;
  category: ActivityCategory;
  actor: "owner" | "agent" | "executor" | "system";
}
export interface PublicActivityView {
  kind: "task_activity";
  generatedAt: string;
  items: PublicActivityItem[];
  counts: Record<ActivityCategory, number>;
  privacy: { categoriesOnly: true; amounts: false; quantities: false; addresses: false; freeText: false };
}

/** 公开视图：只有类别 / 时间 / 操作者类别（P-07）。最多给最近 limit 条 */
export function publicActivityView(rows: Array<Pick<TimelineRow, "at" | "type" | "actor">>, nowIso: string, limit = 200): PublicActivityView {
  const counts = Object.fromEntries(ACTIVITY_CATEGORIES.map((c) => [c, 0])) as Record<ActivityCategory, number>;
  const items = rows.map((r) => {
    const category = categoryOf(r.type);
    counts[category] += 1;
    return { at: r.at.toISOString(), category, actor: publicActor(r.actor) };
  });
  return { kind: "task_activity", generatedAt: nowIso, items: items.slice(-limit), counts, privacy: { categoriesOnly: true, amounts: false, quantities: false, addresses: false, freeText: false } };
}
