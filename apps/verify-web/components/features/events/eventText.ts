/**
 * 事件台的纯函数（无 React，单测覆盖）：事件名按 locale、类型等级、时间跨度、横向范围、按天分组、新鲜度。
 * 接口没有按语言分开的名字字段时，按已知格式在本地翻：中文页不出英文「earnings」，英文页不出中文名。
 */
import type { EventKind, MarketEvent } from "@chaconne/core/verify";
import type { Locale } from "@/lib/i18n";
import type { Tone } from "@/lib/status";

type Pair = { zh: string; en: string };
const HOUR = 3_600_000;
const DAY = 86_400_000;

/** 类型 → 等级徽章（文案 + 色调）。一级宏观 / 财报 / 公司行动最可能触发暂停规则，用 warn；紫色不表达状态 */
export const KIND_META: Record<EventKind, Pair & { tone: Tone }> = {
  MACRO_TIER1: { zh: "一级宏观", en: "Tier-1 macro", tone: "warn" },
  EARNINGS: { zh: "财报", en: "Earnings", tone: "warn" },
  CORPORATE_ACTION: { zh: "公司行动", en: "Corporate action", tone: "warn" },
  FED_BLACKOUT: { zh: "联储静默期", en: "Fed blackout", tone: "info" },
  FED_SPEECH: { zh: "联储讲话", en: "Fed speech", tone: "info" },
  MACRO_TIER2: { zh: "二级宏观", en: "Tier-2 macro", tone: "neutral" },
  MARKET_HOLIDAY: { zh: "休市", en: "Market holiday", tone: "neutral" },
  EARLY_CLOSE: { zh: "提前收盘", en: "Early close", tone: "neutral" },
};
export function kindMeta(kind: string): Pair & { tone: Tone } {
  return KIND_META[kind as EventKind] ?? { zh: "其它事件", en: "Other event", tone: "neutral" };
}

const HAS_CJK = /[㐀-鿿]/;
/** 已知中文名 → 英文（来源 crowsnest 只给中文名） */
const ZH_TO_EN: Record<string, string> = {
  "PCE物价": "PCE prices", "非农就业": "Nonfarm payrolls", "初请失业金": "Initial jobless claims", "ADP就业": "ADP employment",
  "JOLTS职位空缺": "JOLTS job openings", "ISM制造业": "ISM manufacturing", "ISM服务业": "ISM services", "零售销售": "Retail sales",
  "EIA原油库存周报": "EIA weekly crude inventories", "H.4.1联储资产表": "Fed H.4.1 balance sheet", "UMich通胀预期": "UMich inflation expectations",
  "FOMC 声明": "FOMC statement", "美国中期选举结果": "US midterm election results", "财政部季度再融资声明 QRA": "Treasury quarterly refunding (QRA)",
  "日本全国CPI": "Japan national CPI", "日本每月勤劳统计(工资)": "Japan monthly labour survey (wages)",
};
const STANCE: Record<string, string> = { "投票·中性": "voter, neutral", "投票·鸽": "voter, dovish", "投票·鹰": "voter, hawkish", "投票·待定": "voter, undecided", "名单外": "non-voter" };
const MONTH_EN = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** 只有日期（YYYY-MM-DD）→「10月6日」/「Oct 6」；不把 ISO 日期直出（E3） */
export function dateOnly(dateLocal: string, locale: Locale): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateLocal);
  if (!m) return locale === "zh" ? "日期未返回" : "date not returned";
  const mo = Number(m[2]);
  const d = Number(m[3]);
  return locale === "zh" ? `${mo}月${d}日` : `${MONTH_EN[mo - 1] ?? mo} ${d}`;
}

function localized(ev: MarketEvent, locale: Locale): string | null {
  const e = ev as MarketEvent & { nameZh?: unknown; nameEn?: unknown; names?: Record<string, unknown>; i18n?: Record<string, { name?: unknown }> };
  const cands = [locale === "zh" ? e.nameZh : e.nameEn, e.names?.[locale], e.i18n?.[locale]?.name];
  for (const c of cands) if (typeof c === "string" && c.trim()) return c.trim();
  return null;
}

function toEnglish(name: string, ev: MarketEvent): string {
  if (ZH_TO_EN[name]) return ZH_TO_EN[name];
  let m = /^(.+?) 讲话（(.+)）$/.exec(name);
  if (m) return `${m[1]} speech${STANCE[m[2]!] ? ` (${STANCE[m[2]!]})` : ""}`;
  m = /^(\d+)Y国债拍卖$/.exec(name);
  if (m) return `${m[1]}-year Treasury auction`;
  m = /^UMich消费者信心(初值|终值)\((\d+)月\)$/.exec(name);
  if (m) return `UMich consumer sentiment, ${m[1] === "初值" ? "preliminary" : "final"} (${MONTH_EN[Number(m[2]) - 1] ?? m[2]})`;
  m = /^FOMC (\d+)月会议纪要$/.exec(name);
  if (m) return `FOMC minutes (${MONTH_EN[Number(m[1]) - 1] ?? m[1]} meeting)`;
  m = /^FOMC 静默期(开始|结束)（(.+)）$/.exec(name);
  if (m) return `FOMC blackout ${m[1] === "开始" ? "begins" : "ends"} (${m[2]})`;
  return `${kindMeta(ev.kind).en} · ${dateOnly(ev.dateLocal, "en")}`;
}

/** 事件名：接口按 locale 给的字段优先；否则本地翻已知格式 */
export function eventName(ev: MarketEvent, locale: Locale): string {
  const given = localized(ev, locale);
  if (given) return given;
  const name = (ev.name ?? "").trim();
  if (locale === "zh") {
    const m = /^(\S+) earnings (.+)$/i.exec(name);
    if (m) return `${m[1]} 财报（${m[2]}）`;
    return name || `${kindMeta(ev.kind).zh} · ${dateOnly(ev.dateLocal, "zh")}`;
  }
  return name && !HAS_CJK.test(name) ? name : toEnglish(name, ev);
}

/** 纽约本地日 00:00 对应的 UTC 毫秒（夏令时自动） */
export function nyMidnightUtc(dateLocal: string): number {
  const [y, mo, d] = dateLocal.split("-").map(Number) as [number, number, number];
  const noon = Date.UTC(y, mo - 1, d, 12);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hourCycle: "h23" }).formatToParts(new Date(noon));
  const nyHour = Number(parts.find((p) => p.type === "hour")?.value ?? 8);
  return Date.UTC(y, mo - 1, d) + (12 - nyHour) * HOUR;
}

/** 事件自身跨度：有确切时刻 → 一个点；只有日期 → 纽约本地整日 */
export function eventSpan(ev: MarketEvent): { startMs: number; endMs: number; exact: boolean } {
  if (ev.datePrecision === "exact" && ev.scheduledAtUtc) {
    const t = Date.parse(ev.scheduledAtUtc);
    if (Number.isFinite(t)) return { startMs: t, endMs: t, exact: true };
  }
  const s = nyMidnightUtc(ev.dateLocal);
  return { startMs: s, endMs: s + DAY, exact: false };
}

/** 展示用时刻：确切时刻，或来源给了估计时刻（页面同时标「估计」）；只有日期 → null（写「全天」） */
export function shownAt(ev: MarketEvent): number | null {
  if (!ev.scheduledAtUtc) return null;
  const t = Date.parse(ev.scheduledAtUtc);
  return Number.isFinite(t) ? t : null;
}

/** 是否落在「接下来 h 小时」：已取消不算；刚过去 2 小时内的确切事件仍列出（事件后窗口可能还在）；窗口仍在进行的也算 */
export function inHorizon(ev: MarketEvent, nowMs: number, hours: number, windowEndMs: number | null = null): boolean {
  if (ev.status === "cancelled") return false;
  const span = eventSpan(ev);
  const end = Math.max(span.exact ? span.endMs + 2 * HOUR : span.endMs, windowEndMs ?? -Infinity);
  return end >= nowMs && span.startMs <= nowMs + hours * HOUR;
}

/** /v1/events 的日期查询范围（YYYY-MM-DD，前后各放一天，再由 inHorizon 精确过滤） */
export function queryRange(nowMs: number, hours: number): { from: string; to: string } {
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  return { from: iso(nowMs - DAY), to: iso(nowMs + hours * HOUR + DAY) };
}

const pad = (n: number) => String(n).padStart(2, "0");
function localDayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
/** 分组用的日期：有（确切或估计）时刻按浏览器本地日，与行上显示的时间一致；只有日期的按来源日期 */
export function dayKeyOf(ev: MarketEvent): string {
  const at = shownAt(ev);
  return at !== null ? localDayKey(at) : ev.dateLocal;
}

/** 「今天 · 10/03 周六」/「Tomorrow · Sun, Oct 4」 */
export function dayLabel(key: string, locale: Locale, nowMs: number): string {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  const date = new Date(y, m - 1, d, 12);
  const today = localDayKey(nowMs);
  const diff = Math.round((Date.UTC(y, m - 1, d) - Date.parse(`${today}T00:00:00Z`)) / DAY);
  const rel = locale === "zh" ? ({ [-1]: "昨天", 0: "今天", 1: "明天", 2: "后天" } as Record<number, string>)[diff] : ({ [-1]: "Yesterday", 0: "Today", 1: "Tomorrow" } as Record<number, string>)[diff];
  const abs = locale === "zh"
    ? `${pad(m)}/${pad(d)} ${new Intl.DateTimeFormat("zh-CN", { weekday: "short" }).format(date)}`
    : new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric" }).format(date);
  return rel ? `${rel} · ${abs}` : abs;
}

/** 按天分组并排序（组内按开始时间） */
export function groupByDay<T>(rows: T[], ev: (r: T) => MarketEvent): Array<{ key: string; rows: T[] }> {
  const at = (e: MarketEvent) => shownAt(e) ?? eventSpan(e).startMs;
  const sorted = [...rows].sort((a, b) => at(ev(a)) - at(ev(b)) || ev(a).id.localeCompare(ev(b).id));
  const out: Array<{ key: string; rows: T[] }> = [];
  for (const r of sorted) {
    const k = dayKeyOf(ev(r));
    const last = out[out.length - 1];
    if (last && last.key === k) last.rows.push(r);
    else out.push({ key: k, rows: [r] });
  }
  return out;
}

/** 偏差：改期了多少；拿不到原定时间就说「未返回」，不补 0 */
export function deviationText(ev: MarketEvent, locale: Locale): string {
  const zh = locale === "zh";
  if (ev.revisedFrom) {
    const was = ev.revisedFrom.scheduledAtUtc ? Date.parse(ev.revisedFrom.scheduledAtUtc) : nyMidnightUtc(ev.revisedFrom.dateLocal);
    const delta = eventSpan(ev).startMs - was;
    if (Number.isFinite(delta) && delta !== 0) {
      const h = Math.abs(delta) / HOUR;
      const amount = h >= 24 ? (zh ? `${Math.round(h / 24)} 天` : `${Math.round(h / 24)} d`) : zh ? `${Math.round(h * 10) / 10} 小时` : `${Math.round(h * 10) / 10} h`;
      return zh ? `较原定${delta > 0 ? "推迟" : "提前"} ${amount}（原定 ${dateOnly(ev.revisedFrom.dateLocal, "zh")}）` : `${delta > 0 ? "Delayed" : "Moved earlier"} by ${amount} (was ${dateOnly(ev.revisedFrom.dateLocal, "en")})`;
    }
  }
  if (!ev.revision) return zh ? "与首次发布一致" : "Unchanged since first published";
  return zh ? `已修订 ${ev.revision} 次（原定时间未返回）` : `Revised ${ev.revision} time(s) (original time not returned)`;
}

/** 同一来源最近一次抓取 = 该数据源的心跳；拿不到返回 null（页面写「未返回」） */
export function heartbeatOf(source: string | null, events: MarketEvent[]): string | null {
  let best: number | null = null;
  for (const e of events) {
    if (source !== null && e.source !== source) continue;
    const t = Date.parse(e.sourceFetchedAt);
    if (Number.isFinite(t) && (best === null || t > best)) best = t;
  }
  return best === null ? null : new Date(best).toISOString();
}
