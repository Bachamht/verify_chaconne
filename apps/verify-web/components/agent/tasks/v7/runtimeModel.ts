/**
 * 任务页 v7（P3）的纯逻辑：presence 文案键、活动类别、轮询间隔、四问卡的数据来源。页面、公开看板与测试共用。
 */
import type { AgentPresence, TaskRuntime } from "@chaconne/core/verify";
import type { ActivityItem } from "@/lib/api-v2";

/** presence → i18n.v7 键 */
export function presenceKey(p: AgentPresence | null | undefined): string {
  if (!p || p.mode === "none") return "pres_none";
  if (p.mode === "byo") return p.state === "online" ? "pres_online" : "pres_offline";
  return `pres_${p.state}`;
}

/** 轮次在跑 / 等成交 → 3 s；其它 10 s；页面隐藏 → 不轮询（开发计划 §0.5 勘误 #4） */
export const POLL_FAST_MS = 3000;
export const POLL_SLOW_MS = 10_000;
export function pollIntervalMs(runtime: TaskRuntime | null | undefined, hidden: boolean): number | null {
  if (hidden) return null;
  return isBusy(runtime) ? POLL_FAST_MS : POLL_SLOW_MS;
}
export function isBusy(runtime: TaskRuntime | null | undefined): boolean {
  const p = runtime?.presence;
  if (p?.mode === "hosted" && (p.state === "working" || p.state === "awaiting_fill" || p.state === "starting")) return true;
  return runtime?.executor?.state === "busy";
}

export { ACTIVITY_CATEGORIES, activityCategory, isCategory, type ActivityCategory } from "@/lib/activityCategory";

/** 活动的人话：服务端写好的短句（note）优先，否则用类别标签 */
export function activityHasText(it: Pick<ActivityItem, "note">): boolean {
  return typeof it.note === "string" && it.note.trim().length > 0;
}

/** 合并增量页：按 id 去重，按时间升序 */
export function mergeActivity(prev: ActivityItem[], next: ActivityItem[], cap = 300): ActivityItem[] {
  const seen = new Map<string, ActivityItem>();
  for (const x of [...prev, ...next]) seen.set(String(x.id), x);
  const all = [...seen.values()].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || (Number(a.id) || 0) - (Number(b.id) || 0));
  return all.length > cap ? all.slice(-cap) : all;
}

/** 四问卡第 4 问：阻塞项在前，提醒在后 */
export function sortNeedsOwner<T extends { blocking: boolean }>(items: readonly T[] | null | undefined): T[] {
  return [...(items ?? [])].sort((a, b) => Number(b.blocking) - Number(a.blocking));
}

/** 预算已用 / 剩余（最小单位字符串）；used 不可得 → null */
export function budgetUsage(capRaw: string | null | undefined, spentRaw: string | null | undefined): { used: string; left: string } | null {
  if (!capRaw || spentRaw === null || spentRaw === undefined || !/^\d+$/.test(capRaw) || !/^\d+$/.test(spentRaw)) return null;
  const cap = BigInt(capRaw);
  const used = BigInt(spentRaw);
  return { used: used.toString(), left: (cap > used ? cap - used : 0n).toString() };
}
