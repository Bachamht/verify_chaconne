/**
 * C5 Missions：从事件日历 × 资产覆盖生成"今晚可以交给 Agent 的事"。
 * 有事件 → 事件任务（草案带 §1.3 条件，模式 SIMULATION，等用户改成真实授权）；
 * 无事件 / 事件源未接上 → **标注日期**的回放任务，绝不把回放包装成实时。
 * 纯函数；HTTP 与 A2MCP 共用。
 */
import { NYSE_CALENDAR, type MarketCalendar } from "@chaconne/core";
import { hashCanonical, type Condition, type ConditionSet, type MarketEvent, type PlaybookId } from "@chaconne/core/verify";
import { previousTradingDay } from "../recaps/window";

export interface MissionAsset {
  assetKey: string;
  displaySymbol: string;
  underlyingId: string;
  executionAllowed: boolean;
}
export interface MissionDraft {
  playbookId: PlaybookId;
  mode: "SIMULATION" | "REPLAY";
  params: Record<string, unknown>;
  conditions: ConditionSet;
}
export interface Mission {
  id: string;
  kind: "event" | "replay" | "simulation";
  mode: "SIMULATION" | "REPLAY";
  title: { en: string; zh: string };
  why: { en: string; zh: string };
  /** 标注日期：事件日或回放日（YYYY-MM-DD，纽约本地） */
  dateLabel: string;
  eventId: string | null;
  eventKind: string | null;
  eventStatus: string | null;
  assetKey: string | null;
  underlyingId: string | null;
  draft: MissionDraft;
  /** 页面入口：预填表单 */
  href: string;
}
export interface MissionInput {
  now: Date;
  /** null = 事件源未接上（Lane D） */
  events: MarketEvent[] | null;
  assets: MissionAsset[];
  /** 用户持仓/关注的 assetKey（可选，用于优先排序） */
  focus?: string[];
  horizonDays?: number;
  calendar?: MarketCalendar;
}

export function conditionSet(items: Condition[]): ConditionSet {
  return { version: "conditions/1", items, hash: hashCanonical({ version: "conditions/1", items }) as `0x${string}` };
}

const sym = (a: MissionAsset) => a.displaySymbol;

export function buildMissions(i: MissionInput): Mission[] {
  const cal = i.calendar ?? NYSE_CALENDAR;
  const horizonMs = (i.horizonDays ?? 14) * 86_400_000;
  const nowMs = i.now.getTime();
  const covered = i.assets.filter((a) => a.executionAllowed);
  const byUnderlying = new Map<string, MissionAsset>();
  for (const a of covered) byUnderlying.set(a.underlyingId.toLowerCase(), a);
  const focus = new Set((i.focus ?? []).map((k) => k.toLowerCase()));
  const out: Mission[] = [];

  if (i.events) {
    const upcoming = i.events
      .filter((e) => e.status !== "cancelled")
      .filter((e) => {
        const t = e.scheduledAtUtc ? Date.parse(e.scheduledAtUtc) : Date.parse(`${e.dateLocal}T12:00:00Z`);
        return t >= nowMs - 6 * 3600_000 && t <= nowMs + horizonMs;
      })
      .sort((a, b) => a.dateLocal.localeCompare(b.dateLocal));
    for (const e of upcoming) {
      if (e.kind === "EARNINGS") {
        for (const u of e.underlyingIds) {
          const a = byUnderlying.get(u.toLowerCase());
          if (!a) continue;
          out.push({
            id: `msn_${e.id}_${a.assetKey.slice(-8)}`,
            kind: "event",
            mode: "SIMULATION",
            title: { en: `Set an earnings wait window on a ${sym(a)} accumulate plan`, zh: `为 ${sym(a)} 的加仓计划设置财报等待窗口` },
            why: { en: `${e.name} is ${e.status} for ${e.dateLocal}${e.sessionHint ? ` (${e.sessionHint})` : ""}; the plan waits 1 trading day before and 1 regular session after, then re-checks the live reference.`, zh: `${e.name} 于 ${e.dateLocal}${e.sessionHint ? `（${e.sessionHint}）` : ""}，状态 ${e.status}；计划在财报前 1 个交易日、后 1 个常规时段内等待，之后重新核对实时参考价。` },
            dateLabel: e.dateLocal,
            eventId: e.id,
            eventKind: e.kind,
            eventStatus: e.status,
            assetKey: a.assetKey,
            underlyingId: a.underlyingId,
            draft: { playbookId: "event_aware_accumulate", mode: "SIMULATION", params: { outputAssetKey: a.assetKey, steps: 3 }, conditions: conditionSet([{ type: "session", allow: ["US_REGULAR"] }, { type: "avoid_event_window", kinds: ["MACRO_TIER1"], beforeMin: 30, afterMin: 20, includeEstimated: true, wholeDayIfDayPrecision: true }, { type: "earnings_window", beforeTradingDays: 1, afterSessions: 1, requireRegularSessionAfter: true, requireLiveReferenceAfter: true }]) },
            href: `/agent?entry=buy&playbook=event_aware_accumulate&asset=${encodeURIComponent(a.assetKey)}&event=${encodeURIComponent(e.id)}`,
          });
        }
      } else if (e.kind === "MACRO_TIER1" || e.kind === "FED_SPEECH") {
        const a = covered.find((x) => focus.has(x.assetKey.toLowerCase())) ?? covered[0];
        if (!a) continue;
        out.push({
          id: `msn_${e.id}_compare`,
          kind: "event",
          mode: "SIMULATION",
          title: { en: `Compare two post-open policies around ${e.name} (simulation)`, zh: `围绕 ${e.name} 在模拟中比较两种开盘后策略` },
          why: { en: `${e.name} on ${e.dateLocal} (${e.datePrecision === "exact" ? "time confirmed" : "date-level precision"}). Same evidence snapshot, one variant avoids the event window, one does not; no execution.`, zh: `${e.name}（${e.dateLocal}，${e.datePrecision === "exact" ? "时刻已确认" : "只到日期精度"}）。同一份证据快照，一个变体避开事件窗口、一个不避；不执行。` },
          dateLabel: e.dateLocal,
          eventId: e.id,
          eventKind: e.kind,
          eventStatus: e.status,
          assetKey: a.assetKey,
          underlyingId: a.underlyingId,
          draft: { playbookId: "session_dca", mode: "SIMULATION", params: { outputAssetKey: a.assetKey, steps: 2 }, conditions: conditionSet([{ type: "session", allow: ["US_REGULAR"] }, { type: "avoid_event_window", kinds: ["MACRO_TIER1"], beforeMin: 30, afterMin: 20, includeEstimated: true, wholeDayIfDayPrecision: e.datePrecision !== "exact" }]) },
          href: `/agent?entry=compare&asset=${encodeURIComponent(a.assetKey)}&event=${encodeURIComponent(e.id)}`,
        });
      }
    }
  }

  if (out.length === 0) {
    // 无事件（或事件源未接上）：标注日期的回放任务
    const nyToday = i.now.toISOString().slice(0, 10);
    const replayDate = previousTradingDay(nyToday, cal);
    const a = covered.find((x) => focus.has(x.assetKey.toLowerCase())) ?? covered[0];
    if (a) {
      out.push({
        id: `msn_replay_${replayDate}_${a.assetKey.slice(-8)}`,
        kind: "replay",
        mode: "REPLAY",
        title: { en: `Replay a Session DCA decision for ${sym(a)} on ${replayDate}`, zh: `回放 ${replayDate} 对 ${sym(a)} 的 Session DCA 决策` },
        why: { en: i.events === null ? "The event calendar is not available right now, so tonight's mission is a dated replay: only information known at each point in time is used, and gaps are shown as gaps." : "No relevant event in the horizon, so tonight's mission is a dated replay: only information known at each point in time is used, and gaps are shown as gaps.", zh: i.events === null ? "事件日历暂不可用，所以今晚的任务是一段标注日期的回放：只用当时已可知的信息，缺口如实显示。" : "范围内没有相关事件，所以今晚的任务是一段标注日期的回放：只用当时已可知的信息，缺口如实显示。" },
        dateLabel: replayDate,
        eventId: null,
        eventKind: null,
        eventStatus: null,
        assetKey: a.assetKey,
        underlyingId: a.underlyingId,
        draft: { playbookId: "session_dca", mode: "REPLAY", params: { outputAssetKey: a.assetKey, steps: 2, from: `${replayDate}T00:00:00Z`, to: `${replayDate}T23:59:59Z` }, conditions: conditionSet([{ type: "session", allow: ["US_REGULAR"] }, { type: "min_gap_trading_days", days: 1 }]) },
        href: `/agent/lab?replay=1&asset=${encodeURIComponent(a.assetKey)}&date=${replayDate}`,
      });
    }
  }
  return out;
}
