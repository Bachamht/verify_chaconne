/**
 * 公开值守看板的唯一文字来源（P6）：类别 / 角色 / 状态 → 固定标签。
 * 认不出的类别显示「其它活动」，原始字符串（可能含金额、地址、自由文本）永不上屏。
 * 从 components/live/AgentWatchBoard.tsx 移来（v7 与 v8 看板共用；旧组件 re-export 保持导入路径）。
 */
import { tv, tvMaybe } from "@/lib/i18n.v7";
import { isCategory } from "@/components/agent/tasks/v7/runtimeModel";

const PRESENCE = ["starting", "working", "awaiting_fill", "waiting", "blocked_owner", "blocked_operator", "paused", "ended", "online", "offline"];

/** Lane R 公开类别（records/activity.ts ACTIVITY_CATEGORIES） */
const R_CATEGORIES = ["task", "authorization", "decision", "wait", "trade", "execution", "data", "fault", "recovery", "owner_action", "other"];

/** 类别 → 固定标签（看板唯一的文字来源） */
export function boardLabel(category: string, locale: "zh" | "en"): string {
  return (isCategory(category) || R_CATEGORIES.includes(category) ? tvMaybe(locale, `cat_${category}`) : null) ?? tv(locale, "cat_other");
}
export function actorLabel(actor: string | undefined, locale: "zh" | "en"): string | null {
  return actor && ["owner", "agent", "executor", "system"].includes(actor) ? tvMaybe(locale, `pub_actor_${actor}`) : null;
}
export function presenceLabel(p: string | null | undefined, locale: "zh" | "en"): string | null {
  return p && PRESENCE.includes(p) ? tvMaybe(locale, `pres_${p}`) : null;
}
