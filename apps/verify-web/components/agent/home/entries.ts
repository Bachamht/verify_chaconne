/** 首页四入口与示例任务（纯数据，页面与测试共用）。条件写法 = core contracts §1.3；不含金额/钱包。 */
import type { Condition, PlaybookId } from "@chaconne/core/verify";

export type EntryId = "buy" | "wait" | "compare";
export const ENTRIES: Array<{ id: EntryId; key: "ag_entry_buy" | "ag_entry_impact" | "ag_entry_wait" | "ag_entry_compare"; blurb: { en: string; zh: string } }> = [
  { id: "buy", key: "ag_entry_buy", blurb: { en: "Pick a playbook and conditions; simulate first, authorize later.", zh: "选模板和条件；先模拟，之后再授权。" } },
  { id: "wait", key: "ag_entry_wait", blurb: { en: "Why hasn't a task bought yet? All blockers, next check.", zh: "任务为什么还没买？全部阻塞项与下次检查点。" } },
  { id: "compare", key: "ag_entry_compare", blurb: { en: "Two condition sets, one evidence snapshot, no execution.", zh: "两套条件、同一份证据快照、不执行。" } },
];

export interface SamplePlaybook {
  /** 模板 id（页面用它选模板；同一个 playbook 可以有多套条件） */
  id: string;
  playbookId: PlaybookId;
  title: { en: string; zh: string };
  /** 一句话说明：它会怎么做 */
  what: { en: string; zh: string };
  /** 默认步数 */
  steps: number;
  conditions: Condition[];
  /** 用哪一类事件解释这个模板 */
  eventKinds: string[];
}
/**
 * 网页模板 = playbook + 一套条件。链上股票 24 小时可交易：不再默认限制美股常规时段（表单里可勾选）。
 * 需要实时参考价的条件（折价观察）在盘外没有判断依据，会等到常规时段——模板说明里写明。
 */
export const SAMPLES: SamplePlaybook[] = [
  { id: "dca", playbookId: "session_dca", title: { en: "Buy in three steps", zh: "分三次买入" }, what: { en: "Three steps at least one trading day apart, any hour; a missed window is deferred, never merged.", zh: "分三次买，每次至少隔一个交易日，24 小时都可以执行；错过就顺延，不合并。" }, steps: 3, conditions: [{ type: "min_gap_trading_days", days: 1 }], eventKinds: [] },
  { id: "avoid_events", playbookId: "event_aware_accumulate", title: { en: "Avoid major events", zh: "避开重要事件" }, what: { en: "Waits 30 min before and 20 min after tier-1 macro releases and around the company's earnings, then buys.", zh: "一级宏观数据前 30 分钟、后 20 分钟，以及财报前后先等一等，再买。" }, steps: 3, conditions: [{ type: "min_gap_trading_days", days: 1 }, { type: "avoid_event_window", kinds: ["MACRO_TIER1"], beforeMin: 30, afterMin: 20, includeEstimated: true, wholeDayIfDayPrecision: true }, { type: "earnings_window", beforeTradingDays: 1, afterSessions: 1, requireRegularSessionAfter: true, requireLiveReferenceAfter: true }], eventKinds: ["EARNINGS", "MACRO_TIER1"] },
  { id: "calm", playbookId: "session_dca", title: { en: "Buy in calm markets", zh: "市场平静时再买" }, what: { en: "Buys only outside the Fed blackout period, when VIX is at or below 25, and away from tier-1 releases and Fed speeches.", zh: "只在联储静默期之外、VIX 不高于 25、且避开一级数据与联储讲话前后时买入。" }, steps: 3, conditions: [{ type: "min_gap_trading_days", days: 1 }, { type: "not_in_fed_blackout" }, { type: "max_vix", value: 25 }, { type: "avoid_event_window", kinds: ["MACRO_TIER1", "FED_SPEECH"], beforeMin: 30, afterMin: 20, includeEstimated: true, wholeDayIfDayPrecision: true }], eventKinds: ["MACRO_TIER1", "FED_SPEECH"] },
  { id: "after_data", playbookId: "session_dca", title: { en: "Buy after data confirms", zh: "数据公布后确认再买" }, what: { en: "Stays out of the hour around tier-1 releases (CPI, jobs, FOMC); after a release, buys only once the cross-asset reaction reads as relief or transmission, not divergence.", zh: "一级数据（CPI、非农、FOMC）前后一小时不动；数据公布后，跨资产反应是「缓和」或「传导」才买，「背离」不买。" }, steps: 3, conditions: [{ type: "min_gap_trading_days", days: 1 }, { type: "avoid_event_window", kinds: ["MACRO_TIER1"], beforeMin: 60, afterMin: 60, includeEstimated: true, wholeDayIfDayPrecision: true }, { type: "require_cross_asset_confirmation", acceptStates: ["relief", "transmission"] }], eventKinds: ["MACRO_TIER1"] },
  { id: "discount", playbookId: "discount_watch", title: { en: "Watch a price condition", zh: "观察价格条件" }, what: { en: "Buys only when the on-chain price is at most 0.3% above the live reference. Needs a live reference, so it decides during US regular hours and waits otherwise.", zh: "链上价不高于实时参考价 0.3% 溢价时才买。需要实时参考价，所以只在美股常规时段有判断，其它时间等待。" }, steps: 2, conditions: [{ type: "premium_bps_lte", value: 30, referenceKind: "live", liveOnlyForExecution: true }], eventKinds: [] },
];
export const sampleById = (id: string | null | undefined) => SAMPLES.find((s) => s.id === id) ?? null;
/** 草案只带 playbookId 时，取该 playbook 的第一套模板 */
export const sampleForPlaybook = (playbookId: string | null | undefined) => SAMPLES.find((s) => s.playbookId === playbookId) ?? null;

export interface CompareVariant {
  label: string;
  items: Condition[];
}
export const COMPARE_PRESETS: Array<{ id: string; title: { en: string; zh: string }; variants: [CompareVariant, CompareVariant] }> = [
  { id: "session", title: { en: "Regular US session only vs. 24 hours", zh: "只在美股常规时段 vs 24 小时" }, variants: [{ label: "regular_only", items: [{ type: "session", allow: ["US_REGULAR"] }, { type: "min_gap_trading_days", days: 1 }] }, { label: "any_hour", items: [{ type: "min_gap_trading_days", days: 1 }] }] },
  { id: "event_window", title: { en: "Avoid the event window vs. don't", zh: "避开事件窗口 vs 不避" }, variants: [{ label: "avoid_window", items: [{ type: "min_gap_trading_days", days: 1 }, { type: "avoid_event_window", kinds: ["MACRO_TIER1"], beforeMin: 30, afterMin: 20, includeEstimated: true, wholeDayIfDayPrecision: true }] }, { label: "no_window", items: [{ type: "min_gap_trading_days", days: 1 }] }] },
  { id: "gap", title: { en: "1 trading day apart vs. 3", zh: "隔 1 个交易日 vs 隔 3 个" }, variants: [{ label: "gap_1", items: [{ type: "min_gap_trading_days", days: 1 }] }, { label: "gap_3", items: [{ type: "min_gap_trading_days", days: 3 }] }] },
];
