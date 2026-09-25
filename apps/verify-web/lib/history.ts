"use client";
/** 本浏览器打开任务的索引，只保存在 localStorage；不代表钱包同步或服务端任务状态。 */
export type HistoryKind = "job" | "plan" | "mandate" | "simulation" | "agent_task";
export interface HistoryItem {
  kind: HistoryKind;
  id: string;
  title: string;
  createdAt: string;
  owner?: string | null;
  /** New-visitor simulations reopen in their isolated guided review. */
  isolatedSimulation?: boolean;
}
const KEY = "verify_history_v1";
const MAX = 200;
/** Shared with the isolated onboarding session; no task or draft storage is swept by prefix. */
export const ONBOARDING_SNAPSHOT_PREFIX = "verify_onboarding_snapshot_v1:";

export function history(): HistoryItem[] {
  try {
    const raw = localStorage.getItem(KEY);
    const arr = raw ? (JSON.parse(raw) as HistoryItem[]) : [];
    return Array.isArray(arr) ? arr.filter((x) => x && typeof x.id === "string" && typeof x.kind === "string") : [];
  } catch {
    return [];
  }
}

export function remember(item: Omit<HistoryItem, "createdAt"> & { createdAt?: string }): void {
  try {
    const now = new Date().toISOString();
    const rest = history().filter((x) => !(x.kind === item.kind && x.id === item.id));
    const next: HistoryItem[] = [{ ...item, createdAt: item.createdAt ?? now }, ...rest].slice(0, MAX);
    localStorage.setItem(KEY, JSON.stringify(next));
    window.dispatchEvent(new CustomEvent("verify:history"));
  } catch {
    /* 私密窗口等：忽略 */
  }
}

export function forget(kind: HistoryKind, id: string): void {
  try {
    const items = history();
    removeIsolatedSnapshots(items.filter((x) => x.kind === kind && x.id === id));
    localStorage.setItem(KEY, JSON.stringify(items.filter((x) => !(x.kind === kind && x.id === id))));
    window.dispatchEvent(new CustomEvent("verify:history"));
  } catch {
    /* ignore */
  }
}

export function clearHistory(): void {
  try {
    removeIsolatedSnapshots(history());
    localStorage.removeItem(KEY);
    window.dispatchEvent(new CustomEvent("verify:history"));
  } catch {
    /* ignore */
  }
}

/** Delete snapshots first, so a failed removal does not leave hidden data behind a forgotten record. */
function removeIsolatedSnapshots(items: HistoryItem[]): void {
  for (const item of items) {
    if (item.isolatedSimulation && isAgentTask(item)) localStorage.removeItem(ONBOARDING_SNAPSHOT_PREFIX + item.id);
  }
}

/** 早期 TaskForm 曾把 tsk_ 记录为 mandate；读取时兼容，不改写旧数据。 */
export function isAgentTask(item: HistoryItem): boolean {
  return item.kind === "agent_task" || (item.kind === "mandate" && item.id.startsWith("tsk_"));
}

export function agentTaskHistory(items: HistoryItem[] = history()): HistoryItem[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    if (!isAgentTask(item) || seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

export function hrefFor(item: HistoryItem): string {
  if (item.isolatedSimulation && isAgentTask(item)) return "/start?task=" + encodeURIComponent(item.id);
  if (isAgentTask(item)) return `/agent/tasks/${encodeURIComponent(item.id)}`;
  switch (item.kind) {
    case "job":
      return `/jobs/${item.id}`;
    case "plan":
      return `/plan?plan=${item.id}`;
    case "mandate":
      return `/tasks/${item.id}`;
    case "simulation":
      return `/play?simulation=${item.id}`;
    case "agent_task":
      return `/agent/tasks/${encodeURIComponent(item.id)}`;
  }
}
