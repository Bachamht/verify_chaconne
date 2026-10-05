/**
 * v8 导航单一来源（方案 §3.3）：页头、侧栏、⌘K 都读这里，不再各写一份。
 * icon 用名字，components/shell/navIcons.tsx 映射到 lucide 组件（本文件不引 React，便于单测）。
 */
import type { Locale } from "./i18n";

export type NavIcon = "today" | "new" | "tasks" | "events" | "funds" | "journal" | "lab" | "keys" | "developers" | "tools" | "verify" | "plan" | "bundle" | "live" | "replay" | "start" | "workspace" | "markets";

export interface NavLink {
  href: string;
  label: Record<Locale, string>;
  icon: NavIcon;
  /** ⌘K 搜索用的额外关键词 */
  keywords?: string[];
  external?: boolean;
}

/** 工作区侧栏主区（AppShell） */
export const NAV_WORKSPACE: readonly NavLink[] = [
  { href: "/agent", label: { zh: "今天", en: "Today" }, icon: "today", keywords: ["home", "首页", "workspace"] },
  { href: "/agent/tasks", label: { zh: "任务", en: "Tasks" }, icon: "tasks", keywords: ["records", "记录"] },
  { href: "/agent/events", label: { zh: "事件", en: "Events" }, icon: "events", keywords: ["calendar", "日历", "earnings", "财报"] },
  { href: "/agent/funds", label: { zh: "资金", en: "Funds" }, icon: "funds", keywords: ["allowance", "额度", "positions", "持仓"] },
  { href: "/agent/journal", label: { zh: "日志", en: "Journal" }, icon: "journal", keywords: ["night", "夜班", "activity"] },
  { href: "/agent/lab", label: { zh: "实验", en: "Lab" }, icon: "lab", keywords: ["diagnose", "诊断", "compare", "对照", "replay", "回放"] },
  { href: "/agent/keys", label: { zh: "Agent 接入 key", en: "Agent API keys" }, icon: "keys", keywords: ["api", "key", "mcp", "sdk"] },
];

export const NAV_NEW_TASK: NavLink = { href: "/agent/new", label: { zh: "新建任务", en: "New task" }, icon: "new", keywords: ["create", "创建"] };

/** 「工具 ▾」：证据复核与公开看板（单笔核验、规划、历史回放的网页 10/5 起删除；对应 API 仍在） */
export const NAV_TOOLS: readonly NavLink[] = [
  { href: "/verify-bundle", label: { zh: "复核证据包", en: "Check an evidence bundle" }, icon: "bundle" },
  { href: "/live", label: { zh: "公开看板", en: "Public board" }, icon: "live" },
];

export const NAV_DEVELOPERS: NavLink = { href: "/developers", label: { zh: "开发者", en: "Developers" }, icon: "developers", keywords: ["api", "mcp", "sdk"] };

/** 营销壳顶栏：只留这几项（方案 §3.2） */
export const NAV_MARKETING: readonly NavLink[] = [
  { href: "/start", label: { zh: "开始", en: "Get started" }, icon: "start" },
  { href: "/agent", label: { zh: "工作区", en: "Workspace" }, icon: "workspace" },
  NAV_DEVELOPERS,
];

export function isActive(pathname: string, href: string): boolean {
  if (href === "/agent") return pathname === "/agent";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** 哪些路径用工作区壳（AppShell）；其余用营销壳 */
export function usesAppShell(pathname: string): boolean {
  return pathname === "/agent" || pathname.startsWith("/agent/") || pathname === "/kit";
}

/** ⌘K 的全部跳转目标（去重） */
export function commandTargets(): NavLink[] {
  const all = [NAV_NEW_TASK, ...NAV_WORKSPACE, ...NAV_TOOLS, NAV_DEVELOPERS, { href: "/start", label: { zh: "开始体验", en: "Get started" }, icon: "start" as const }];
  const seen = new Set<string>();
  return all.filter((n) => (seen.has(n.href) ? false : (seen.add(n.href), true)));
}
