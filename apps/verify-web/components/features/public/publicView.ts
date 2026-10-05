/**
 * 公开页（/live、/live/agent/:shareId、/r/:shareId）的纯视图模型：页面只渲染这里的输出。
 * 隐私硬规则：永不显示钱包地址。服务端已隐藏 owner，这里再做一层纵深防御：
 * 任何 0x + 40 位十六进制（地址形状）的自由文本一律替换；资产名若是地址，显示「未登记资产」。
 * 交易哈希（0x + 64 位）是公开证据，保留，由 <Hash kind="tx"> 截断显示。
 */
import type { Locale } from "@/lib/i18n";
import type { PublicActivityView, PublicReport } from "@/lib/publicData";
import type { Tone, UiStatus } from "@/lib/status";
import { headline } from "@/lib/report-copy";
import { actorLabel, boardLabel, presenceLabel } from "./boardLabels";

/** 地址形状：0x + 恰好 40 位十六进制（后面不能再接十六进制，避免误伤 64 位交易哈希） */
const ADDRESS_RE = /0x[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;

export function hasAddress(text: string): boolean {
  return new RegExp(ADDRESS_RE.source).test(text);
}

export function scrubAddresses(text: string, locale: Locale): string {
  return text.replace(ADDRESS_RE, locale === "zh" ? "（地址已隐藏）" : "(address hidden)");
}

function symbolOf(s: string, locale: Locale): string {
  if (/^0x[0-9a-fA-F]{40}$/.test(s) || /^eip155:\d+:0x/i.test(s)) return locale === "zh" ? "未登记资产" : "Unregistered asset";
  return scrubAddresses(s, locale);
}

/* 策略 / 时段的人话映射只有一份：lib/policyLabels（与报告页、工具页共用） */

/** 公开战报状态 → 界面状态；partial（部分完成）没有对应的 StatusBadge，用 warn 色调标签 */
export function shareUiStatus(status: PublicReport["status"]): { status: UiStatus } | { tone: Tone; label: Record<Locale, string> } {
  switch (status) {
    case "completed": return { status: "done" };
    case "waiting": return { status: "waiting" };
    case "rejected": return { status: "failed" };
    case "simulation": return { status: "simulation" };
    default: return { tone: "warn", label: { zh: "部分完成", en: "Partially completed" } };
  }
}

export interface PublicReportView {
  shareId: string;
  title: string;
  personaName: string | null;
  badge: ReturnType<typeof shareUiStatus>;
  mode: PublicReport["evidenceMode"];
  simulation: boolean;
  goal: { side: "buy" | "sell"; assets: string[]; input: string; amount: string | null; policyId: string };
  completionPct: number | null;
  spent: string | null;
  received: string | null;
  fees: string | null;
  waitingOn: string | null;
  reasonCodes: string[];
  check: PublicReport["check"];
  hashes: { reportHash: string | null; evidenceHash: string | null; txHashes: string[] };
  createdAt: string;
}

/** 战报 → 视图（所有自由文本过一遍地址清洗） */
export function publicReportView(r: PublicReport, locale: Locale): PublicReportView {
  const clean = (s: string | null | undefined) => (s ? scrubAddresses(s, locale) : null);
  const title = r.headline ? (locale === "zh" ? r.headline.zh : r.headline.en) : headline(r.status, r.persona?.personaId ?? null, locale);
  return {
    shareId: r.shareId,
    // 服务端中文标题里的破折号换成逗号（中文页不用「——」）
    title: scrubAddresses(locale === "zh" ? title.replace(/——/g, "，") : title, locale),
    personaName: clean(r.persona?.name?.trim() || null),
    badge: shareUiStatus(r.status),
    mode: r.evidenceMode,
    simulation: r.status === "simulation" || r.evidenceMode === "SIMULATION",
    goal: { side: r.goal.side, assets: r.goal.outputSymbols.map((s) => symbolOf(s, locale)), input: symbolOf(r.goal.inputSymbol, locale), amount: clean(r.goal.amountDisplay), policyId: r.goal.policyId },
    completionPct: r.result.completionBps === null ? null : Math.round(r.result.completionBps / 100),
    spent: clean(r.result.spentDisplay),
    received: clean(r.result.receivedDisplay),
    fees: clean(r.result.feesDisplay),
    waitingOn: clean(r.result.waitingOn),
    reasonCodes: r.result.reasons.map((x) => x.code),
    check: r.check ?? null,
    hashes: { reportHash: r.evidence.reportHash, evidenceHash: r.evidence.evidenceHash, txHashes: r.evidence.txHashes.filter((h) => !hasAddress(h)) },
    createdAt: r.createdAt,
  };
}

/** 公开板 KPI：总数、已完成、模拟、等待中（不含任何金额） */
export function boardKpis(items: PublicReport[]): { total: number; completed: number; simulation: number; waiting: number } {
  return {
    total: items.length,
    completed: items.filter((r) => r.status === "completed").length,
    simulation: items.filter((r) => r.status === "simulation" || r.evidenceMode === "SIMULATION").length,
    waiting: items.filter((r) => r.status === "waiting" || r.status === "partial").length,
  };
}

/** Agent 在线状态 → 界面状态（看板页头的 StatusBadge）；认不出的不显示徽章 */
const PRESENCE_UI: Record<string, UiStatus> = {
  starting: "running", working: "running", awaiting_fill: "running", online: "running",
  waiting: "waiting", blocked_operator: "waiting", blocked_owner: "needs_you", paused: "paused", ended: "done",
};
export function presenceUiStatus(p: string | null | undefined): UiStatus | null {
  return (p && PRESENCE_UI[p]) || null;
}

export interface WatchItemView { key: string; at: string; label: string; actor: string | null }
export interface WatchView { now: string | null; mode: "LIVE" | "SIMULATION" | null; items: WatchItemView[]; total: number; fills: number; lastAt: string | null }

/** 值守看板 → 视图：只有固定标签 + 时间；最新在前，最多 60 条 */
export function watchView(v: PublicActivityView | null, locale: Locale): WatchView {
  const sorted = [...(v?.items ?? [])].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const items = sorted.slice(0, 60).map((it, i) => ({ key: `${it.at}-${i}`, at: it.at, label: boardLabel(it.category, locale), actor: actorLabel(it.actor, locale) }));
  const now = presenceLabel(v?.presence, locale) ?? items[0]?.label ?? null;
  const fills = sorted.filter((it) => it.category === "fill_confirmed" || it.category === "trade").length;
  return { now, mode: v?.mode ?? null, items, total: sorted.length, fills, lastAt: sorted[0]?.at ?? null };
}
