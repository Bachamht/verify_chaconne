/**
 * C5 Missions：从事件日历 × 资产覆盖生成"今晚可以交给 Agent 的事"。
 * 有事件 → 事件任务（草案带 §1.3 条件，模式 SIMULATION，等用户改成真实授权）；
 * 无事件 / 事件源未接上 → **标注日期**的回放任务，绝不把回放包装成实时。
 * 纯函数；HTTP 与 A2MCP 共用。
 */
import { NYSE_CALENDAR, type MarketCalendar } from "@chaconne/core";
import { hashCanonical, type AssetRegistry, type Condition, type ConditionSet, type MarketEvent, type PlaybookId } from "@chaconne/core/verify";
import { previousTradingDay } from "../recaps/window";

export interface MissionAsset {
  assetKey: string;
  displaySymbol: string;
  underlyingId: string;
  executionAllowed: boolean;
}
/**
 * 任务草案 = `POST /v1/tasks` 原样可接受的请求体（V-25）：只有 SIMULATION 一种模式（任务层没有 REPLAY 模式），
 * params 只含模板认识的键（inputAssetKey / outputAssetKey / steps / perStepAmountRaw）；回放建议放在 Mission.replay，不进请求体。
 * ownerAddress 未知时不写（调用方补上再提交）。
 */
export interface MissionDraft {
  clientRequestId: string;
  playbookId: PlaybookId;
  mode: "SIMULATION";
  ownerAddress?: string;
  params: { inputAssetKey: string; outputAssetKey: string; steps: number; perStepAmountRaw: string };
  conditions: ConditionSet;
}
/** 无事件时的回放建议（不是任务参数；`/v1/replays` 或 /agent/lab 回放页用） */
export interface MissionReplay {
  assetKey: string;
  from: string;
  to: string;
  url: string;
}
/** 草案的资金侧缺省：登记表里优先级最高的资金币种（USDG，其次第一个 stable_input）+ 1 个单位/步 */
export interface DraftFunding {
  inputAssetKey: string;
  perStepAmountRaw: string;
  displaySymbol: string;
}
export function defaultDraftFunding(registry: AssetRegistry): DraftFunding | null {
  const stables = registry.entries.filter((e) => e.role === "stable_input");
  const e = stables.find((x) => x.displaySymbol === "USDG") ?? stables[0];
  if (!e) return null;
  return { inputAssetKey: e.assetKey, perStepAmountRaw: (10n ** BigInt(e.tokenDecimals)).toString(), displaySymbol: e.displaySymbol };
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
  /** kind=replay 时的回放区间；其它为 null */
  replay: MissionReplay | null;
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
  /** 草案资金侧（inputAssetKey / perStepAmountRaw）；由 defaultDraftFunding(registry) 得到 */
  funding: DraftFunding;
  /** 已知 owner 时写进草案（草案即可直接提交） */
  owner?: string | null;
}

export function conditionSet(items: Condition[]): ConditionSet {
  return { version: "conditions/1", items, hash: hashCanonical({ version: "conditions/1", items }) as `0x${string}` };
}

const sym = (a: MissionAsset) => a.displaySymbol;
/** clientRequestId 只允许 [A-Za-z0-9_\-:.]，≤128 */
const draftRequestId = (missionId: string) => `draft-${missionId.replace(/[^A-Za-z0-9_\-:.]/g, "-")}`.slice(0, 128);

export function buildMissions(i: MissionInput): Mission[] {
  const cal = i.calendar ?? NYSE_CALENDAR;
  const horizonMs = (i.horizonDays ?? 14) * 86_400_000;
  const nowMs = i.now.getTime();
  const covered = i.assets.filter((a) => a.executionAllowed);
  const byUnderlying = new Map<string, MissionAsset>();
  for (const a of covered) byUnderlying.set(a.underlyingId.toLowerCase(), a);
  const focus = new Set((i.focus ?? []).map((k) => k.toLowerCase()));
  const out: Mission[] = [];
  const draft = (id: string, playbookId: PlaybookId, a: MissionAsset, steps: number, items: Condition[]): MissionDraft => ({
    clientRequestId: draftRequestId(id),
    playbookId,
    mode: "SIMULATION",
    ...(i.owner ? { ownerAddress: i.owner } : {}),
    params: { inputAssetKey: i.funding.inputAssetKey, outputAssetKey: a.assetKey, steps, perStepAmountRaw: i.funding.perStepAmountRaw },
    conditions: conditionSet(items),
  });

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
          const id = `msn_${e.id}_${a.assetKey.slice(-8)}`;
          out.push({
            id,
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
            draft: draft(id, "event_aware_accumulate", a, 3, [{ type: "session", allow: ["US_REGULAR"] }, { type: "avoid_event_window", kinds: ["MACRO_TIER1"], beforeMin: 30, afterMin: 20, includeEstimated: true, wholeDayIfDayPrecision: true }, { type: "earnings_window", beforeTradingDays: 1, afterSessions: 1, requireRegularSessionAfter: true, requireLiveReferenceAfter: true }]),
            replay: null,
            href: `/agent?entry=buy&playbook=event_aware_accumulate&asset=${encodeURIComponent(a.assetKey)}&event=${encodeURIComponent(e.id)}`,
          });
        }
      } else if (e.kind === "MACRO_TIER1" || e.kind === "FED_SPEECH") {
        const a = covered.find((x) => focus.has(x.assetKey.toLowerCase())) ?? covered[0];
        if (!a) continue;
        const id = `msn_${e.id}_compare`;
        out.push({
          id,
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
          draft: draft(id, "session_dca", a, 2, [{ type: "session", allow: ["US_REGULAR"] }, { type: "avoid_event_window", kinds: ["MACRO_TIER1"], beforeMin: 30, afterMin: 20, includeEstimated: true, wholeDayIfDayPrecision: e.datePrecision !== "exact" }]),
          replay: null,
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
      const id = `msn_replay_${replayDate}_${a.assetKey.slice(-8)}`;
      const href = `/agent/lab?replay=1&asset=${encodeURIComponent(a.assetKey)}&date=${replayDate}`;
      out.push({
        id,
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
        // 草案本身仍是可提交的 SIMULATION 任务；回放区间单独给（任务层没有 REPLAY 模式，from/to 不是模板参数）
        draft: draft(id, "session_dca", a, 2, [{ type: "session", allow: ["US_REGULAR"] }, { type: "min_gap_trading_days", days: 1 }]),
        replay: { assetKey: a.assetKey, from: `${replayDate}T00:00:00Z`, to: `${replayDate}T23:59:59Z`, url: href },
        href,
      });
    }
  }
  return out;
}
