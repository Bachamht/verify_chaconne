/** 首页四入口与示例任务（纯数据，页面与测试共用）。条件写法 = core contracts §1.3；不含金额/钱包。 */
import type { Condition, PlaybookId } from "@chaconne/core/verify";

export type EntryId = "buy" | "impact" | "wait" | "compare";
export const ENTRIES: Array<{ id: EntryId; key: "ag_entry_buy" | "ag_entry_impact" | "ag_entry_wait" | "ag_entry_compare"; blurb: { en: string; zh: string } }> = [
  { id: "buy", key: "ag_entry_buy", blurb: { en: "Pick a playbook and conditions; simulate first, authorize later.", zh: "选模板和条件；先模拟，之后再授权。" } },
  { id: "impact", key: "ag_entry_impact", blurb: { en: "Which scheduled events touch my holdings or tasks tonight?", zh: "今晚有哪些排期事件与我的持仓或任务有关？" } },
  { id: "wait", key: "ag_entry_wait", blurb: { en: "Why hasn't a task bought yet? All blockers, next check.", zh: "任务为什么还没买？全部阻塞项与下次检查点。" } },
  { id: "compare", key: "ag_entry_compare", blurb: { en: "Two condition sets, one evidence snapshot, no execution.", zh: "两套条件、同一份证据快照、不执行。" } },
];

export interface SamplePlaybook {
  playbookId: PlaybookId;
  title: { en: string; zh: string };
  what: { en: string; zh: string };
  /** 默认步数 */
  steps: number;
  conditions: Condition[];
  /** 用哪一类事件解释这个模板 */
  eventKinds: string[];
}
export const SAMPLES: SamplePlaybook[] = [
  { playbookId: "session_dca", title: { en: "Session DCA", zh: "分段定投" }, what: { en: "N steps, one per US regular session, at least one trading day apart; a missed window is deferred, never merged.", zh: "N 步，每步只在美股常规时段，至少隔一个交易日；错过的窗口只顺延，不合并。" }, steps: 3, conditions: [{ type: "session", allow: ["US_REGULAR"] }, { type: "min_gap_trading_days", days: 1 }, { type: "avoid_event_window", kinds: ["MACRO_TIER1"], beforeMin: 30, afterMin: 20, includeEstimated: true, wholeDayIfDayPrecision: true }], eventKinds: ["MACRO_TIER1"] },
  { playbookId: "event_aware_accumulate", title: { en: "Event-aware accumulate", zh: "避开事件的加仓" }, what: { en: "Waits around tier-1 macro releases and the earnings window (1 trading day before, 1 regular session after), then re-checks the live reference.", zh: "在一级宏观数据与财报窗口（前 1 个交易日、后 1 个常规时段）等待，之后重新核对实时参考价。" }, steps: 3, conditions: [{ type: "session", allow: ["US_REGULAR"] }, { type: "avoid_event_window", kinds: ["MACRO_TIER1"], beforeMin: 30, afterMin: 20, includeEstimated: true, wholeDayIfDayPrecision: true }, { type: "earnings_window", beforeTradingDays: 1, afterSessions: 1, requireRegularSessionAfter: true, requireLiveReferenceAfter: true }], eventKinds: ["EARNINGS", "MACRO_TIER1"] },
  { playbookId: "discount_watch", title: { en: "Discount watch", zh: "折价观察" }, what: { en: "Buys only when the on-chain price sits at or below a premium threshold versus the LIVE reference; close-based references are simulation-only.", zh: "只在链上价相对**实时**参考价的溢价不高于阈值时买；收盘口径只能用于模拟。" }, steps: 2, conditions: [{ type: "session", allow: ["US_REGULAR"] }, { type: "premium_bps_lte", value: 30, referenceKind: "live", liveOnlyForExecution: true }], eventKinds: [] },
];

export interface CompareVariant {
  label: string;
  items: Condition[];
}
export const COMPARE_PRESETS: Array<{ id: string; title: { en: string; zh: string }; variants: [CompareVariant, CompareVariant] }> = [
  { id: "event_window", title: { en: "Avoid the event window vs. don't", zh: "避开事件窗口 vs 不避" }, variants: [{ label: "avoid_window", items: [{ type: "session", allow: ["US_REGULAR"] }, { type: "avoid_event_window", kinds: ["MACRO_TIER1"], beforeMin: 30, afterMin: 20, includeEstimated: true, wholeDayIfDayPrecision: true }] }, { label: "no_window", items: [{ type: "session", allow: ["US_REGULAR"] }] }] },
  { id: "gap", title: { en: "1 trading day apart vs. 3", zh: "隔 1 个交易日 vs 隔 3 个" }, variants: [{ label: "gap_1", items: [{ type: "session", allow: ["US_REGULAR"] }, { type: "min_gap_trading_days", days: 1 }] }, { label: "gap_3", items: [{ type: "session", allow: ["US_REGULAR"] }, { type: "min_gap_trading_days", days: 3 }] }] },
];
