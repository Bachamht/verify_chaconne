/** 任务列表的筛选（URL 值校验）、计数与删除确认文案。纯函数，test/v8Tasks.test.ts 覆盖 */
import type { Locale } from "@/lib/i18n";
import type { StatusGroup, TaskRow } from "./model";

export const STATUS_GROUPS: readonly StatusGroup[] = ["active", "needs_you", "paused", "ended"];
const L = (locale: Locale, zh: string, en: string) => (locale === "zh" ? zh : en);

export interface TaskFilter { group: StatusGroup | "all"; mode: "all" | "live" | "simulation"; q: string }

export function parseGroup(v: string): StatusGroup | "all" {
  return (STATUS_GROUPS as readonly string[]).includes(v) ? (v as StatusGroup) : "all";
}
export function parseMode(v: string): TaskFilter["mode"] {
  return v === "live" || v === "simulation" ? v : "all";
}

export function filterRows(rows: readonly TaskRow[], f: TaskFilter): TaskRow[] {
  const q = f.q.trim().toLowerCase();
  return rows.filter((r) => {
    if (f.group !== "all" && r.group !== f.group) return false;
    if (f.mode === "live" && r.mode !== "LIVE") return false;
    if (f.mode === "simulation" && r.mode !== "SIMULATION") return false;
    if (q && !r.title.toLowerCase().includes(q) && !r.id.toLowerCase().includes(q) && !r.stocks.some((s) => s.toLowerCase().includes(q))) return false;
    return true;
  });
}

export function groupCounts(rows: readonly TaskRow[]): Record<StatusGroup | "all", number> {
  const c = { all: rows.length, active: 0, needs_you: 0, paused: 0, ended: 0 };
  for (const r of rows) c[r.group] += 1;
  return c;
}

/** 删除的二次确认文案：运行中的会先取消（沿用旧版说明） */
export function deleteConsequence(rawStatus: string, locale: Locale): string {
  const running = !["COMPLETED", "CANCELLED", "REVOKED", "EXPIRED"].includes(rawStatus);
  return running
    ? L(locale, "这个任务还在运行：删除会先取消它（服务侧停止签发；已取走的证书到期前仍可能执行），然后从列表移除。链上额度不会自动收回。", "This task is still running: deleting cancels it first (issuance stops; pulled certificates may execute until they expire), then removes it from your lists. On-chain allowance is not reclaimed automatically.")
    : L(locale, "从列表移除这个任务？记录与证据保留，控制台仍可打开。", "Remove this task from your lists? Records and evidence are kept; the console stays available.");
}
