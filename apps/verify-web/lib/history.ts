"use client";
/** 「我的任务」（V-10）：只记在本浏览器的 localStorage，不上传；服务端没有列表接口，任务靠 id 隔离。 */
export type HistoryKind = "job" | "plan" | "mandate" | "simulation";
export interface HistoryItem {
  kind: HistoryKind;
  id: string;
  title: string;
  createdAt: string;
  owner?: string | null;
}
const KEY = "verify_history_v1";
const MAX = 200;

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
    localStorage.setItem(KEY, JSON.stringify(history().filter((x) => !(x.kind === kind && x.id === id))));
    window.dispatchEvent(new CustomEvent("verify:history"));
  } catch {
    /* ignore */
  }
}

export function clearHistory(): void {
  try {
    localStorage.removeItem(KEY);
    window.dispatchEvent(new CustomEvent("verify:history"));
  } catch {
    /* ignore */
  }
}

export function hrefFor(item: HistoryItem): string {
  switch (item.kind) {
    case "job":
      return `/jobs/${item.id}`;
    case "plan":
      return `/plan?plan=${item.id}`;
    case "mandate":
      return `/tasks/${item.id}`;
    case "simulation":
      return `/play?simulation=${item.id}`;
  }
}
