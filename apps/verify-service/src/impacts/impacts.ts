/**
 * 影响计算（C6，§11.5）：事件 × 相关资产（underlyingIds ↔ registry.underlyingId）× 持仓 × 任务 → relation → effect → actions。
 *  - relation：公司事件（EARNINGS / CORPORATE_ACTION）命中任务规则 → user_rule；否则 company_direct；宏观一律 macro_research
 *  - 宏观只标研究关联，文案不写涨跌（E-04）
 *  - 只产生动作建议，不发任何执行（E-07）
 * 纯函数：输入全部显式给出（事件列表、登记表、持仓/任务 reader 结果、now、horizon）。
 */
import { NYSE_CALENDAR, type MarketCalendar } from "@chaconne/core";
import { IMPACT_ACTIONS, type AssetRegistry, type Blocker, type EventImpact, type EventKind, type ImpactAction, type ImpactEffect, type ImpactRelation, type IsoUtc, type MarketEvent } from "@chaconne/core/verify";
import { evaluateRule, matchRules, type RuleMatch } from "../events/earnings/window";
import { nyLocalToUtc } from "../events/earnings/mapping";
import type { Holding, ReaderResult, TaskLite } from "./readers";

export const COMPANY_KINDS: EventKind[] = ["EARNINGS", "CORPORATE_ACTION"];
export type Relevance = "holding_and_task" | "holding" | "task" | "universe";

export interface RuleView {
  taskId: string;
  ruleLabel: string;
  active: boolean;
  upcoming: boolean;
  needsChoice: boolean;
  nextCheckAt: IsoUtc | null;
  window: { startUtc: IsoUtc; endUtc: IsoUtc; basis: string } | null;
}

export interface EventDeskItem {
  event: MarketEvent;
  impact: EventImpact;
  relevance: Relevance;
  rules: RuleView[];
  blockers: Blocker[];
  /** 宏观事件固定研究关联说明码（页面映射文案，不写涨跌） */
  noteCode: "MACRO_RESEARCH_ONLY" | "COMPANY_EVENT" | null;
}

export interface ImpactInputs {
  owner: string;
  nowIso: IsoUtc;
  horizonHours: number;
  events: MarketEvent[];
  registry: AssetRegistry;
  holdings: ReaderResult<Holding>;
  tasks: ReaderResult<TaskLite>;
  calendar?: MarketCalendar;
  /** 回看多久内结束的事件仍列出（财报后等待）；默认 72 h */
  lookbackHours?: number;
}

const DAY_MS = 86_400_000;

/** 事件自身的时间跨度（无任务规则时用于 horizon 过滤）：exact → 点；day → 纽约本地整日 */
export function eventSpan(ev: MarketEvent): { startMs: number; endMs: number } {
  if (ev.datePrecision === "exact" && ev.scheduledAtUtc) {
    const t = Date.parse(ev.scheduledAtUtc);
    return { startMs: t, endMs: t };
  }
  const s = Date.parse(nyLocalToUtc(ev.dateLocal, 0, 0));
  return { startMs: s, endMs: s + DAY_MS };
}

export function relationOf(ev: MarketEvent, ruleMatched: boolean): ImpactRelation {
  if (!COMPANY_KINDS.includes(ev.kind)) return "macro_research";
  return ruleMatched ? "user_rule" : "company_direct";
}

export function computeImpacts(i: ImpactInputs): EventDeskItem[] {
  const cal = i.calendar ?? NYSE_CALENDAR;
  const now = Date.parse(i.nowIso);
  const horizonEnd = now + i.horizonHours * 3600_000;
  const lookbackStart = now - (i.lookbackHours ?? 72) * 3600_000;
  const assetsByUnderlying = new Map<string, string[]>();
  for (const e of i.registry.entries) {
    if (e.role !== "stock_output") continue;
    const list = assetsByUnderlying.get(e.underlyingId) ?? [];
    list.push(e.assetKey);
    assetsByUnderlying.set(e.underlyingId, list);
  }
  const held = new Map(i.holdings.items.map((h) => [h.assetKey, h]));

  const items: EventDeskItem[] = [];
  for (const ev of i.events) {
    if (ev.status === "cancelled") continue;
    const assets = ev.underlyingIds.flatMap((u) => assetsByUnderlying.get(u) ?? []);
    const holdings = assets.filter((a) => held.has(a)).map((a) => ({ assetKey: a, balanceRaw: held.get(a)!.balanceRaw }));

    // 任务：资产相关 或 规则命中（宏观事件靠规则）
    const taskViews: EventImpact["tasks"] = [];
    const rules: RuleView[] = [];
    const blockers: Blocker[] = [];
    let earliestStart = Number.POSITIVE_INFINITY;
    let latestEnd = Number.NEGATIVE_INFINITY;
    let anyRule = false;
    for (const t of i.tasks.items) {
      const assetRelated = t.assetKeys.some((a) => assets.includes(a));
      const matches: RuleMatch[] = matchRules(ev, t.conditions.items, cal);
      // 公司事件的规则只对涉及该资产的任务有意义；宏观规则对所有任务有效
      const effective = COMPANY_KINDS.includes(ev.kind) ? (assetRelated ? matches : []) : matches;
      if (!assetRelated && effective.length === 0) continue;
      let effect: ImpactEffect = "none";
      const matched: string[] = [];
      for (const m of effective) {
        anyRule = true;
        const r = evaluateRule(ev, m, i.nowIso);
        matched.push(m.ruleLabel);
        if (m.result.ok) {
          earliestStart = Math.min(earliestStart, Date.parse(m.result.window.startUtc));
          latestEnd = Math.max(latestEnd, Date.parse(m.result.window.endUtc));
        }
        rules.push({ taskId: t.id, ruleLabel: m.ruleLabel, active: r.active, upcoming: r.upcoming, needsChoice: !m.result.ok, nextCheckAt: r.nextCheckAt, window: m.result.ok ? m.result.window : null });
        if (r.blocker) blockers.push(r.blocker);
        if (!m.result.ok) effect = "recheck";
        else if (r.active || r.upcoming) effect = effect === "recheck" ? "recheck" : "wait";
      }
      if (effective.length > 0 && ev.revision > 1 && effect === "wait") effect = "recheck";
      taskViews.push({ taskId: t.id, matchedRules: matched, effect });
    }

    // horizon 过滤：有规则窗口用窗口，否则用事件自身跨度
    const span = eventSpan(ev);
    const startMs = Number.isFinite(earliestStart) ? Math.min(earliestStart, span.startMs) : span.startMs;
    const endMs = Number.isFinite(latestEnd) ? Math.max(latestEnd, span.endMs) : span.endMs;
    if (endMs < lookbackStart || startMs > horizonEnd) continue;

    const relation = relationOf(ev, anyRule);
    const isCompany = COMPANY_KINDS.includes(ev.kind);
    // 动作按契约 IMPACT_ACTIONS 顺序输出
    const enabled = new Set<ImpactAction>(["view_evidence", "keep_plan", "preview_new_plan"]);
    if (isCompany || anyRule || taskViews.length > 0) enabled.add("create_watch_task");
    if (anyRule) enabled.add("wait_by_rule");
    if (taskViews.length > 0) enabled.add("pause_issuance");
    const actions = IMPACT_ACTIONS.filter((a) => enabled.has(a));

    const relevance: Relevance = holdings.length > 0 && taskViews.length > 0 ? "holding_and_task" : holdings.length > 0 ? "holding" : taskViews.length > 0 ? "task" : "universe";
    items.push({
      event: ev,
      impact: { eventId: ev.id, relation, assets, holdings, tasks: taskViews, actions },
      relevance,
      rules,
      blockers,
      noteCode: isCompany ? "COMPANY_EVENT" : "MACRO_RESEARCH_ONLY",
    });
  }
  const rank: Record<Relevance, number> = { holding_and_task: 0, holding: 1, task: 2, universe: 3 };
  return items.sort((a, b) => rank[a.relevance] - rank[b.relevance] || eventSpan(a.event).startMs - eventSpan(b.event).startMs || a.event.id.localeCompare(b.event.id));
}
