/**
 * 事件 × 未结束任务 → 命中与人话（纯函数，单测覆盖）。
 * 与服务端 impacts/matchRules 同口径：earnings_window 只对财报且任务涉及该股票；avoid_event_window 看 kinds 与 includeEstimated；
 * 公司事件的规则只对涉及该资产的任务生效，宏观规则对所有任务生效。**只为未结束的任务算**（已完成 / 取消 / 到期 / 撤销的跳过），
 * 在浏览器里算，毫秒级，不等服务端整份影响清单。
 */
import type { Condition, ImpactAction, MarketEvent, Task } from "@chaconne/core/verify";
import { conditionLike } from "@/lib/conditions";
import type { Locale } from "@/lib/i18n";
import { isTerminal, taskUiStatus, type UiStatus } from "@/lib/status";
import { nyMidnightUtc } from "./eventText";

type Avoid = Extract<Condition, { type: "avoid_event_window" }>;
type Earnings = Extract<Condition, { type: "earnings_window" }>;
export type HitRule =
  | { kind: "avoid"; c: Avoid; window: { startMs: number; endMs: number; basis: "exact" | "whole_day" } | null }
  | { kind: "earnings"; c: Earnings }
  | { kind: "watch" }
  | { kind: "asset"; symbols: string[] };
export interface TaskLite { id: string; title: string; status: UiStatus; conditions: Condition[]; watchKinds: string[]; assetKeys: string[] }
export interface TaskHit { task: TaskLite; rules: HitRule[] }

const COMPANY = new Set(["EARNINGS", "CORPORATE_ACTION"]);

/** 未结束：终态与撤销中都不算（撤销中的任务不会再签发） */
export function isOpenStatus(s: UiStatus): boolean {
  return !isTerminal(s) && s !== "revoking";
}

export function toTaskLite(t: Task, locale: Locale): TaskLite {
  const keys = new Set<string>();
  for (const k of t.scope?.outputAssetKeys ?? []) keys.add(k);
  for (const leg of (t.goal as { legs?: Array<{ outputAssetKey?: string }> } | undefined)?.legs ?? []) if (leg.outputAssetKey) keys.add(leg.outputAssetKey);
  const goalOut = (t.goal as { outputAssetKey?: string } | undefined)?.outputAssetKey;
  if (goalOut) keys.add(goalOut);
  const objective = t.scope?.objective?.trim();
  return {
    id: t.id,
    title: objective || (locale === "zh" ? `任务 ${t.id.slice(-6)}` : `Task ${t.id.slice(-6)}`),
    status: taskUiStatus(t.status),
    conditions: t.conditions?.items ?? [],
    watchKinds: (t.brief as { watch?: { kinds?: string[] } } | undefined)?.watch?.kinds ?? [],
    assetKeys: [...keys],
  };
}

export function openTasks(tasks: Task[], locale: Locale): TaskLite[] {
  return tasks.map((t) => toTaskLite(t, locale)).filter((t) => isOpenStatus(t.status));
}

function avoidWindow(ev: MarketEvent, c: Avoid): { startMs: number; endMs: number; basis: "exact" | "whole_day" } | null {
  if (ev.datePrecision === "exact" && ev.scheduledAtUtc) {
    const t = Date.parse(ev.scheduledAtUtc);
    return { startMs: t - c.beforeMin * 60_000, endMs: t + c.afterMin * 60_000, basis: "exact" };
  }
  if (c.wholeDayIfDayPrecision) {
    const s = nyMidnightUtc(ev.dateLocal);
    return { startMs: s, endMs: s + 86_400_000, basis: "whole_day" };
  }
  return null;
}

/** 一个事件命中哪些未结束任务；assetsOfEvent = 事件 underlyingIds 映射出的资产 key，symbolOf 给资产显示名 */
export function matchEvent(ev: MarketEvent, tasks: TaskLite[], assetsOfEvent: string[], symbolOf: (k: string) => string = (k) => k): TaskHit[] {
  const estimated = ev.status === "estimated" || ev.datePrecision === "estimate";
  const company = COMPANY.has(ev.kind);
  const hits: TaskHit[] = [];
  for (const t of tasks) {
    const related = t.assetKeys.filter((k) => assetsOfEvent.includes(k));
    const rules: HitRule[] = [];
    for (const c of t.conditions) {
      if (c.type === "earnings_window" && ev.kind === "EARNINGS" && related.length) rules.push({ kind: "earnings", c });
      else if (c.type === "avoid_event_window" && c.kinds.includes(ev.kind) && (c.includeEstimated || !estimated) && (!company || related.length)) rules.push({ kind: "avoid", c, window: avoidWindow(ev, c) });
    }
    if (!rules.length && t.watchKinds.includes(ev.kind) && (!company || related.length)) rules.push({ kind: "watch" });
    if (!rules.length && related.length) rules.push({ kind: "asset", symbols: related.map(symbolOf) });
    if (rules.length) hits.push({ task: t, rules });
  }
  return hits;
}

/** 命中的规则窗口最晚何时结束（事件过去后窗口仍在 → 仍列在台上） */
export function latestWindowEnd(hits: TaskHit[]): number | null {
  let end: number | null = null;
  for (const h of hits) for (const r of h.rules) if (r.kind === "avoid" && r.window) end = Math.max(end ?? -Infinity, r.window.endMs);
  return end;
}

/** 会改变 Agent 行为的命中（暂停规则）；只关注 / 只涉及资产的不算「会暂停」 */
export function isBlockingRule(r: HitRule): boolean {
  return r.kind === "avoid" || r.kind === "earnings";
}

/** 一句人话：「会在事件前 30 分钟到后 20 分钟暂停买入」；subject 给了就放句首（「任务 A 会在…」） */
export function ruleSentence(r: HitRule, locale: Locale, subject?: string): string {
  if (locale === "zh") {
    const who = subject ? `${subject} ` : "";
    switch (r.kind) {
      case "avoid":
        if (!r.window) return `${subject ? `${subject}：` : ""}这个事件只有日期没有时刻，需要你选择整日等待或忽略，Agent 不会替你补时刻`;
        if (r.window.basis === "whole_day") return `${who}会在事件当天（纽约时间）整天暂停买入`;
        return `${who}会在事件前 ${r.c.beforeMin} 分钟到后 ${r.c.afterMin} 分钟暂停买入`;
      case "earnings":
        return `${who}会在财报前 ${r.c.beforeTradingDays} 个交易日到财报后 ${r.c.afterSessions} 个交易时段内暂停买入${r.c.requireLiveReferenceAfter ? "，之后等实时参考价恢复再买" : ""}`;
      case "watch":
        return `${subject ? `${subject} 的 ` : ""}Agent 关注这类事件，会把它纳入下一次判断，不是固定暂停`;
      case "asset":
        return `${subject ? `${subject} ` : "这个任务"}涉及 ${r.symbols.join("、")}，但没有针对这个事件的暂停规则，Agent 照常判断`;
    }
  }
  const who = subject ?? "This task";
  switch (r.kind) {
    case "avoid":
      if (!r.window) return `${subject ? `${subject}: ` : ""}this event has a date but no time; choose to wait the whole day or ignore it. The agent will not invent a time`;
      if (r.window.basis === "whole_day") return `${who} pauses buying for the whole event day (New York time)`;
      return `${who} pauses buying from ${r.c.beforeMin} min before to ${r.c.afterMin} min after the event`;
    case "earnings":
      return `${who} pauses buying from ${r.c.beforeTradingDays} trading day(s) before to ${r.c.afterSessions} session(s) after the report${r.c.requireLiveReferenceAfter ? ", then waits for a live reference" : ""}`;
    case "watch":
      return `${subject ? `The agent on ${subject}` : "The agent"} watches this kind of event and weighs it in its next decision; no fixed pause`;
    case "asset":
      return `${who} involves ${r.symbols.join(", ")} but has no pause rule for this event; the agent decides as usual`;
  }
}

/** 事件可用的动作（与服务端 computeImpacts 同口径）；主动作固定为「预览条件变更」 */
export function enabledActions(ev: MarketEvent, hits: TaskHit[]): ImpactAction[] {
  const anyRule = hits.some((h) => h.rules.some(isBlockingRule));
  const out: ImpactAction[] = ["view_evidence"];
  if (COMPANY.has(ev.kind) || anyRule || hits.length) out.push("create_watch_task");
  out.push("keep_plan");
  if (anyRule) out.push("wait_by_rule");
  if (hits.length) out.push("pause_issuance");
  out.push("preview_new_plan");
  return out;
}

/** 预览差异一行：新增 / 移除 / 改为；条件串和条件对象都翻成人话 */
export function diffSentence(d: { before: unknown; after: unknown }, locale: Locale): string {
  const zh = locale === "zh";
  if (d.before === null || d.before === undefined) return zh ? `新增：${conditionLike(d.after, locale)}` : `Add: ${conditionLike(d.after, locale)}`;
  if (d.after === null || d.after === undefined) return zh ? `移除：${conditionLike(d.before, locale)}` : `Remove: ${conditionLike(d.before, locale)}`;
  return zh ? `改为：${conditionLike(d.after, locale)}（原来：${conditionLike(d.before, locale)}）` : `Change to: ${conditionLike(d.after, locale)} (was: ${conditionLike(d.before, locale)})`;
}

/** 窗口状态：进行中 / 未开始 / 已结束 */
export function windowPhase(w: { startMs: number; endMs: number }, nowMs: number): "upcoming" | "active" | "over" {
  return nowMs < w.startMs ? "upcoming" : nowMs < w.endMs ? "active" : "over";
}

/**
 * 服务端影响清单 → 阻塞说明，只保留未结束任务的规则（服务端会把已取消任务也算进去）。
 * 窗口进行中 → EVENT_WINDOW_ACTIVE / EARNINGS_WINDOW_ACTIVE（下次检查 = 窗口结束）；只有日期没选整日 → EVENT_DATE_UNCERTAIN。
 */
export function serverBlockers(rules: Array<{ taskId: string; ruleLabel: string; active: boolean; needsChoice: boolean; nextCheckAt: string | null }>, openIds: Set<string>): Array<{ code: string; nextCheckAt: string | null }> {
  const out = new Map<string, { code: string; nextCheckAt: string | null }>();
  for (const r of rules) {
    if (!openIds.has(r.taskId)) continue;
    const code = r.needsChoice ? "EVENT_DATE_UNCERTAIN" : r.active ? (r.ruleLabel.startsWith("earnings_window") ? "EARNINGS_WINDOW_ACTIVE" : "EVENT_WINDOW_ACTIVE") : null;
    if (!code) continue;
    const prev = out.get(code);
    // 同一原因取最晚的下次检查（全部窗口结束才放行）
    if (!prev || (r.nextCheckAt && (!prev.nextCheckAt || r.nextCheckAt > prev.nextCheckAt))) out.set(code, { code, nextCheckAt: r.needsChoice ? null : r.nextCheckAt });
  }
  return [...out.values()];
}

