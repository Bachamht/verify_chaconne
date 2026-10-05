/**
 * /agent「今天」的纯逻辑（无 React，test/v8Tasks.test.ts 覆盖）：
 * 选哪些任务去拉活动流、需要你处理的清单、今日成交、可用预算、下一个事件、Agent 刚说。
 * 拿不到的值返回 null（页面显示「—」），不补 0。
 */
import type { NeedsOwnerItem } from "@chaconne/core/verify";
import type { Locale } from "@/lib/i18n";
import type { ActivityItem, RecordItem } from "@/lib/api-v2";
import { humanizeActivity, type AssetLite } from "@/lib/activityText";
import { formatAbs, toDate } from "@/lib/numbers";
import type { EventDeskItem } from "@/components/agent/events/api";
import { eventTimeMs } from "@/components/agent/crew/nextEvent";
import { isBuyMandate, type AssetInfo, type TaskRow } from "../tasks/model";
import { needAction, type NeedAction } from "../common/needsAction";

const L = (locale: Locale, zh: string, en: string) => (locale === "zh" ? zh : en);

export interface Pulse { taskId: string; ok: boolean; items: ActivityItem[]; needs: NeedsOwnerItem[] | null }

export function startOfLocalDay(now: Date): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 「Agent 刚说」与「今日成交」共用的活动流：只拉 PULSE_CAP 个任务、每个最多 PULSE_LIMIT 条（手机上别和事件请求抢连接） */
export const PULSE_CAP = 3;
export const PULSE_LIMIT = 100;

/**
 * 拉活动流的任务：未结束的任务（真实 / 观察，模式未知的也算）里最近更新的 cap 个。
 * 观察任务不交易，不影响「今日成交」；coversToday = 今天有更新的真实（或模式未知）任务都在里面，否则今日成交写「—」。
 */
export function pickPulseTasks(rows: readonly TaskRow[], now: Date, cap = PULSE_CAP): { ids: string[]; coversToday: boolean } {
  const day = startOfLocalDay(now);
  const today = rows.filter((r) => r.mode !== "SIMULATION" && Date.parse(r.updatedAt) >= day);
  const ids = rows
    .filter((r) => r.group !== "ended")
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, Math.max(0, cap))
    .map((r) => r.id);
  return { ids, coversToday: today.every((r) => ids.includes(r.id)) };
}

/** 今日成交 = 今天（本地日）链上确认的步数；活动流还没拉 / 有任务没拉到 / 没覆盖到今天有更新的任务 → null（「—」） */
export function fillsToday(pulses: readonly Pulse[] | null, coversToday: boolean, now: Date): number | null {
  if (!pulses || !coversToday || pulses.some((p) => !p.ok)) return null;
  const day = startOfLocalDay(now);
  return pulses.reduce((n, p) => n + p.items.filter((i) => i.type === "step_confirmed" && Date.parse(i.at) >= day).length, 0);
}

export interface NeedItem { key: string; taskId: string; title: string; text: string; blocking: boolean; action: NeedAction }
/** 动作映射与任务控制台共用（features/common/needsAction） */
export { needAction };

/**
 * 需要你处理：服务端 runtime.needsOwner（已按 locale 给人话）；
 * 活动流只拉最近 3 个任务；其余任务按状态补一条：「等你签授权」→ 去签（阻塞）；已暂停 → 决定继续或取消（提醒）。
 */
export function needsList(rows: readonly TaskRow[], pulses: readonly Pulse[], locale: Locale): NeedItem[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: NeedItem[] = [];
  const covered = new Set<string>();
  for (const p of pulses) {
    const row = byId.get(p.taskId);
    if (!row || !p.needs) continue;
    covered.add(p.taskId);
    for (const n of p.needs) {
      out.push({ key: `${p.taskId}:${n.code}`, taskId: p.taskId, title: row.title, text: n.text?.[locale] ?? L(locale, "有一项需要你处理", "Something needs you"), blocking: n.blocking, action: needAction(n.action?.kind ?? "open", p.taskId, locale) });
    }
  }
  for (const r of rows) {
    if (covered.has(r.id)) continue;
    if (r.rawStatus === "AWAITING_AUTHORIZATION") out.push({ key: `${r.id}:awaiting`, taskId: r.id, title: r.title, text: L(locale, "委托清单还没签完，任务不会开始", "The delegation checklist is not signed yet; the task will not start"), blocking: true, action: needAction("sign_delegation", r.id, locale) });
    else if (r.group === "paused") out.push({ key: `${r.id}:paused`, taskId: r.id, title: r.title, text: L(locale, "任务已暂停，等你决定继续或取消", "The task is paused; decide whether to resume or cancel"), blocking: false, action: needAction("resume_or_cancel", r.id, locale) });
  }
  return out.sort((a, b) => Number(b.blocking) - Number(a.blocking));
}

/** 可用预算 = 生效中（ACTIVE）的买入授权剩余额度之和；记录没拿到 → null；稳定币未知 → decimals / symbol 为 null（显示「未返回」，不猜） */
export function availableBudget(records: readonly RecordItem[] | null, assets: readonly AssetInfo[]): { raw: string; decimals: number | null; symbol: string | null } | null {
  if (!records) return null;
  const stable = assets.find((a) => a.role === "stable_input") ?? null;
  let left = 0n;
  for (const m of records) {
    if (m.kind !== "mandate" || m.status !== "ACTIVE" || !isBuyMandate(m, assets)) continue;
    if (!/^\d+$/.test(m.budgetCap ?? "") || !/^\d+$/.test(m.spent ?? "0")) continue;
    const d = BigInt(m.budgetCap!) - BigInt(m.spent ?? "0");
    if (d > 0n) left += d;
  }
  return { raw: left.toString(), decimals: stable?.tokenDecimals ?? null, symbol: stable?.displaySymbol ?? null };
}

/** 下一个事件：未发布、未取消、时间在现在之后，按时间升序取 n 个；与你相关的排前面不改变时间顺序 */
export function upcomingEvents(items: readonly EventDeskItem[], now: Date, n = 3): EventDeskItem[] {
  const t = now.getTime();
  return items
    .filter((i) => i.event.status !== "released" && i.event.status !== "cancelled" && eventTimeMs(i.event) >= t)
    .sort((a, b) => eventTimeMs(a.event) - eventTimeMs(b.event))
    .slice(0, n);
}

/** 服务端替 Agent 写的兜底句（不是它的判断），不当原话引用 */
const NOT_A_QUOTE = [/^the agent did not reach a decision/i];
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})/g;

/** 原话里的 ISO 时间换成本地短格式（只改时间写法，不改措辞） */
export function tidyQuote(quote: string, locale: Locale, now: Date = new Date()): string {
  return quote.replace(ISO, (m) => {
    const d = toDate(m);
    return d ? formatAbs(d, locale, now) : m;
  });
}

export interface Saying { key: string; taskId: string; title: string; quote: string; at: string }

/** Agent 刚说：活动流里 Agent 自己的原话（humanizeActivity 的 quote），最新的 n 条 */
export function agentSayings(pulses: readonly Pulse[], rows: readonly TaskRow[], assets: readonly AssetLite[], locale: Locale, n = 3): Saying[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: Saying[] = [];
  for (const p of pulses) {
    const row = byId.get(p.taskId);
    if (!row) continue;
    for (const it of p.items) {
      if (!String(it.actor).startsWith("agent:")) continue;
      const h = humanizeActivity(it, { locale, assets });
      if (!h.quote || NOT_A_QUOTE.some((r) => r.test(h.quote!.trim()))) continue;
      out.push({ key: `${p.taskId}:${it.id}`, taskId: p.taskId, title: row.title, quote: tidyQuote(h.quote, locale), at: it.at });
    }
  }
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, n);
}

export function runningCount(rows: readonly TaskRow[]): number {
  return rows.filter((r) => r.status === "running" || r.status === "waiting").length;
}
