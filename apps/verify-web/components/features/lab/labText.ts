/**
 * 实验页（v8 /agent/lab）的纯逻辑：结论 / 条件项 / 缺口的文案映射、对照四列表的行、证据快照一行摘要、旧链接锚点 → tab。
 * 无 React；test/v8JournalLab.test.ts 覆盖（含「所有条件类型都有文案」）。
 */
import type { Condition, ConditionType } from "@chaconne/core/verify";
import type { Locale } from "@/lib/i18n";
import type { Tone } from "@/lib/status";
import { conditionText } from "@/lib/conditions";
import { apiError } from "@/lib/errors";

export const LAB_TABS = ["diagnose", "compare", "replay"] as const;
export type LabTab = (typeof LAB_TABS)[number];
/** 旧入口用锚点（/agent/lab#wait、#compare、#replay）；v8 用 ?tab= */
export function tabFromLegacy(hash: string | null | undefined, tab: string | null | undefined): LabTab {
  if (tab && (LAB_TABS as readonly string[]).includes(tab)) return tab as LabTab;
  const h = (hash ?? "").replace(/^#/, "");
  if (h === "compare") return "compare";
  if (h === "replay") return "replay";
  return "diagnose";
}

const OUTCOME: Record<string, { zh: string; en: string; tone: Tone }> = {
  SATISFIED: { zh: "放行", en: "Pass", tone: "ok" },
  UNSATISFIED: { zh: "等待", en: "Wait", tone: "warn" },
  INSUFFICIENT_EVIDENCE: { zh: "证据不足", en: "Insufficient evidence", tone: "info" },
};
export function outcomeMeta(o: string | null | undefined, locale: Locale): { label: string; tone: Tone } {
  const m = o ? OUTCOME[o] : undefined;
  return m ? { label: m[locale], tone: m.tone } : { label: locale === "zh" ? "未知" : "Unknown", tone: "muted" };
}

export const CONDITION_LABEL: Record<ConditionType, { zh: string; en: string }> = {
  session: { zh: "交易时段", en: "Trading session" },
  avoid_event_window: { zh: "事件回避窗口", en: "Event avoidance window" },
  earnings_window: { zh: "财报窗口", en: "Earnings window" },
  not_in_fed_blackout: { zh: "美联储静默期", en: "Fed blackout" },
  max_vix: { zh: "VIX 上限", en: "Max VIX" },
  max_move: { zh: "单日涨跌上限", en: "Max daily move" },
  premium_bps_lte: { zh: "溢价上限", en: "Premium cap" },
  min_gap_trading_days: { zh: "两步最少间隔", en: "Minimum gap between steps" },
  max_steps_per_trading_day: { zh: "每日最多步数", en: "Max steps per day" },
  require_cross_asset_confirmation: { zh: "跨资产确认", en: "Cross-asset confirmation" },
  target_price_gte: { zh: "目标价（不低于）", en: "Target price (at or above)" },
  target_price_lte: { zh: "目标价（不高于）", en: "Target price (at or below)" },
  tracked_cost_pnl_pct_gte: { zh: "按成本的盈亏比例", en: "P&L vs tracked cost" },
  cash_floor: { zh: "资金保留下限", en: "Cash floor" },
  thesis_holds: { zh: "理由卡仍成立", en: "Thesis still holds" },
};
export function conditionLabel(t: string, locale: Locale): string {
  return CONDITION_LABEL[t as ConditionType]?.[locale] ?? (locale === "zh" ? "其它条件" : "Other condition");
}

/** 对照的一侧：条件项 → 句子；缺失 → 「无此项」；其它值 → 文本（不出 JSON） */
export function sideText(v: unknown, locale: Locale): string {
  if (v === null || v === undefined) return locale === "zh" ? "无此项" : "Not set";
  if (typeof v === "object" && "type" in (v as object)) {
    try { return conditionText(v as Condition, locale); } catch { /* 落到下面 */ }
  }
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return String(v);
  return locale === "zh" ? "有设置（详见开发者视图）" : "Set (see developer view)";
}

export type DiffKind = "same" | "differs" | "only_a" | "only_b";
export interface CompareRow { key: string; field: string; a: string; b: string; diff: DiffKind; aTone?: Tone; bTone?: Tone }
export function diffLabel(d: DiffKind, locale: Locale): { label: string; tone: Tone } {
  const zh = locale === "zh";
  if (d === "same") return { label: zh ? "相同" : "Same", tone: "muted" };
  if (d === "only_a") return { label: zh ? "只有 A" : "A only", tone: "info" };
  if (d === "only_b") return { label: zh ? "只有 B" : "B only", tone: "info" };
  return { label: zh ? "不同" : "Differs", tone: "warn" };
}

interface OutcomeLite { label: string; outcome: string; blockingCodes?: string[]; nextCheckAt?: string | null }
interface CompareLite {
  outcomeDiff?: OutcomeLite[] | null;
  comparison?: { diff?: Array<{ itemType: string; a: unknown; b: unknown }> } | null;
  planner?: Array<{ summary: { candidateCount: number; verdict: string | null } | null }> | null;
}

/**
 * 四列表（字段 / A / B / 差异）的行：结论、阻塞项数、下次检查、规划器候选，再接逐项条件差异。
 * fmtTime 由调用方注入（页面用本地时间格式，测试用恒等）。
 */
export function compareRows(d: CompareLite, locale: Locale, fmtTime: (iso: string) => string, blockerSentence: (code: string) => string): CompareRow[] {
  const zh = locale === "zh";
  const [oa, ob] = [d.outcomeDiff?.[0], d.outcomeDiff?.[1]];
  const rows: CompareRow[] = [];
  const cmp = (a: string, b: string): DiffKind => (a === b ? "same" : "differs");
  const ma = outcomeMeta(oa?.outcome, locale);
  const mb = outcomeMeta(ob?.outcome, locale);
  rows.push({ key: "outcome", field: zh ? "结论" : "Outcome", a: ma.label, b: mb.label, diff: cmp(ma.label, mb.label), aTone: ma.tone, bTone: mb.tone });
  const blk = (o?: OutcomeLite) => (o?.blockingCodes ?? []).length === 0 ? (zh ? "没有" : "None") : (o!.blockingCodes ?? []).map(blockerSentence).join(zh ? "；" : "; ");
  rows.push({ key: "blockers", field: zh ? "阻塞项" : "Blockers", a: blk(oa), b: blk(ob), diff: cmp(blk(oa), blk(ob)) });
  const next = (o?: OutcomeLite) => (o?.nextCheckAt ? fmtTime(o.nextCheckAt) : (zh ? "未知" : "Unknown"));
  rows.push({ key: "next", field: zh ? "下次检查" : "Next check", a: next(oa), b: next(ob), diff: cmp(next(oa), next(ob)) });
  const plan = (i: number) => {
    const s = d.planner?.[i]?.summary;
    return s ? (zh ? `${s.candidateCount} 个候选` : `${s.candidateCount} candidate(s)`) : (zh ? "不可用" : "Unavailable");
  };
  rows.push({ key: "planner", field: zh ? "规划器（同一报价）" : "Planner (same quote)", a: plan(0), b: plan(1), diff: cmp(plan(0), plan(1)) });
  for (const x of d.comparison?.diff ?? []) {
    const a = sideText(x.a, locale);
    const b = sideText(x.b, locale);
    const diff: DiffKind = x.a == null && x.b != null ? "only_b" : x.b == null && x.a != null ? "only_a" : cmp(a, b);
    rows.push({ key: `item:${x.itemType}`, field: conditionLabel(x.itemType, locale), a, b, diff });
  }
  return rows;
}

/** 证据快照一行摘要：「快照 · 3 个事件版本 · 7 条证据」（时间由页面用 Timestamp 补） */
export function snapshotSummary(s: { eventVersions?: unknown[] | null; evidenceIds?: unknown[] | null } | null | undefined, locale: Locale): string {
  const ev = s?.eventVersions?.length ?? 0;
  const n = s?.evidenceIds?.length ?? 0;
  return locale === "zh" ? `${ev} 个事件版本 · ${n} 条证据` : `${ev} event version(s) · ${n} evidence record(s)`;
}

const GAP: Record<string, { zh: string; en: string }> = {
  NO_ARCHIVE: { zh: "没有存档", en: "No archive" },
  NO_QUOTE: { zh: "没有报价", en: "No quote" },
  REFERENCE_PURGED: { zh: "参考价断供，已清空", en: "Reference purged (feed outage)" },
};
export function gapLabel(reason: string, locale: Locale): string {
  return GAP[reason]?.[locale] ?? (locale === "zh" ? "数据缺口" : "Data gap");
}

export function replayCounts(points: Array<{ outcome: string }>): Record<"SATISFIED" | "UNSATISFIED" | "INSUFFICIENT_EVIDENCE", number> {
  const c = { SATISFIED: 0, UNSATISFIED: 0, INSUFFICIENT_EVIDENCE: 0 };
  for (const p of points) if (p.outcome in c) c[p.outcome as keyof typeof c] += 1;
  return c;
}

/** 回放条的位置（百分比，0–100，供 SVG x / width 属性用） */
export function spanPct(from: string, to: string, runFrom: string, runTo: string): { x: number; w: number } {
  const t0 = Date.parse(runFrom);
  const total = Math.max(1, Date.parse(runTo) - t0);
  const x = Math.min(100, Math.max(0, ((Date.parse(from) - t0) / total) * 100));
  const w = Math.max(0.4, Math.min(100 - x, ((Date.parse(to) - Date.parse(from)) / total) * 100));
  return { x, w };
}

/** 试算（POST）失败的人话：403 单独说（只读环境 / 无权），其余走 lib/errors；不露原始错误码 */
export function actionErrorText(r: { status: number; data: unknown }, locale: Locale): string {
  const zh = locale === "zh";
  if (r.status === 403) return zh ? "服务拒绝了这次试算：当前环境是只读的，或这个钱包无权操作这个任务。换已登录的钱包后重试。" : "The service refused this run: the environment is read-only, or this wallet may not act on this task. Switch to a signed-in wallet and retry.";
  const msg = apiError(r, locale);
  if (!/[A-Za-z]+_[A-Za-z_]+/.test(msg)) return msg;
  return zh ? `请求没有完成（HTTP ${r.status}）。稍后重试。` : `The request did not finish (HTTP ${r.status}). Retry shortly.`;
}

export const EXECUTOR_TEXT: Record<string, { zh: string; en: string }> = {
  online: { zh: "在线", en: "Online" },
  awaiting_signature: { zh: "等你签名", en: "Awaiting your signature" },
  offline: { zh: "离线（观察任务不需要）", en: "Offline (not needed for observation)" },
};

/** VIX 上限：留空 = 不限；填了就必须是大于 0 的数 */
export function vixInvalid(maxVix: string): boolean {
  return maxVix.trim() !== "" && !(Number(maxVix) > 0);
}

/** 回放用到的数据量：接口没给的写「未返回」，不补 0 */
export function sourceCount(v: unknown, locale: Locale): string {
  return typeof v === "number" && Number.isFinite(v) ? String(v) : locale === "zh" ? "未返回" : "not returned";
}
