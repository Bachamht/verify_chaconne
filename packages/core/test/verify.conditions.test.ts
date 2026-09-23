/** v6 Lane B · C2 条件 DSL 与三态求值（K-01/03/04/05/06/07/08、Y-05、T-06、nextCheckAt） */
import { describe, expect, it } from "vitest";
import { hashCanonical } from "../src/verify/canonical";
import { blockersFromEvaluation, makeConditionSet, conditionsHash, emptyConditionEvidence, evaluateConditions, validateConditionSet, type ConditionEvidence, type TaskConditionState } from "../src/verify/conditions";
import { assessContextStaleness, applyFieldStatus } from "../src/verify/context";
import { fixtureEvent, fixtureMarketContext, type FixtureContextArgs } from "../src/verify/context/fixture";
import type { Condition, MarketEvent } from "../src/verify/contracts";
import { validatePlaybookCatalog } from "../src/verify/tasks";
import { NYSE_CALENDAR } from "../src/calendar";

const NOW = "2026-09-18T15:00:00.000Z"; // 周五 11:00 ET 常规时段
const U = "us-equity:FAKE";
const state = (over: Partial<TaskConditionState> = {}): TaskConditionState => ({ underlyingIds: [U], outputAssetKeys: ["eip155:196:0x2222222222222222222222222222222222222222"], mode: "LIVE", lastConfirmedStepAt: null, stepsConfirmedToday: 0, stepsConfirmedTodayInBudgetGroup: null, nextStepAmountRaw: "5000000", ...over });
function evidenceAt(now: string, args: Partial<FixtureContextArgs> = {}, events: MarketEvent[] = []): ConditionEvidence {
  const ctx = fixtureMarketContext({ at: args.at ?? now, events, ...(args.overrides ? { overrides: args.overrides } : {}) });
  const fieldStatus = assessContextStaleness(ctx, now);
  return { ...emptyConditionEvidence(), context: { snapshot: applyFieldStatus(ctx, fieldStatus), fieldStatus, evidenceId: "ev_ctx_1", receivedAt: now }, events: events.map((e, i) => ({ event: e, evidenceId: `ev_evt_${i}` })), earningsCoverage: { [U]: true } };
}
const set = (items: Condition[]) => makeConditionSet(items);

describe("K-01 同输入重复求值同结果（哈希）", () => {
  it("K-01 两次 evaluateConditions 的 perItem 哈希、conditionsHash、nextCheckAt 完全一致", () => {
    const items: Condition[] = [{ type: "session", allow: ["US_REGULAR"] }, { type: "max_vix", value: 30 }, { type: "avoid_event_window", kinds: ["MACRO_TIER1"], beforeMin: 30, afterMin: 20, includeEstimated: true, wholeDayIfDayPrecision: true }, { type: "min_gap_trading_days", days: 1 }];
    const ev = evidenceAt(NOW, {}, [fixtureEvent({ dateLocal: "2026-09-18", scheduledAtUtc: "2026-09-18T15:10:00.000Z" })]);
    const a = evaluateConditions(set(items), ev, state(), NOW);
    const b = evaluateConditions(set(items), structuredClone(ev), state(), NOW);
    expect(hashCanonical(a)).toBe(hashCanonical(b));
    expect(a.conditionsHash).toBe(conditionsHash(items));
    expect(a.outcome).toBe("UNSATISFIED");
    expect(a.nextCheckAt).toBe("2026-09-18T15:30:00.000Z");
  });
});

describe("K-03 三态：证据不足不放行", () => {
  it("K-03 上下文不可达 → 依赖上下文的条件 INSUFFICIENT_EVIDENCE(CONTEXT_UNAVAILABLE)，不依赖的（session/min_gap）照常；总结果不放行", () => {
    const items: Condition[] = [{ type: "session", allow: ["US_REGULAR"] }, { type: "max_vix", value: 30 }, { type: "min_gap_trading_days", days: 1 }];
    const r = evaluateConditions(set(items), emptyConditionEvidence(), state(), NOW);
    expect(r.outcome).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.perItem[0]!.outcome).toBe("SATISFIED");
    expect(r.perItem[1]).toMatchObject({ outcome: "INSUFFICIENT_EVIDENCE", reasons: [{ code: "CONTEXT_UNAVAILABLE" }] });
    expect(r.perItem[2]!.outcome).toBe("SATISFIED");
    const blockers = blockersFromEvaluation(r);
    expect(blockers.map((b) => b.code)).toEqual(["CONTEXT_UNAVAILABLE"]);
  });
  it("K-03 字段 stale → CONTEXT_STALE 只阻塞依赖它的条件；not_in_tier → CONTEXT_FIELD_NOT_IN_TIER", () => {
    const late = "2026-09-18T15:25:00.000Z";
    const ev = evidenceAt(late, { at: NOW });
    const r = evaluateConditions(set([{ type: "max_vix", value: 30 }, { type: "max_move", value: 200 }]), ev, state(), late);
    expect(r.perItem[0]).toMatchObject({ outcome: "INSUFFICIENT_EVIDENCE", reasons: [{ code: "CONTEXT_STALE" }] });
    expect(r.perItem[1]!.outcome).toBe("SATISFIED"); // rates.move 日度定盘仍新鲜
    ev.context!.snapshot.risk.vix = { ...ev.context!.snapshot.risk.vix, value: null, status: "unavailable", note: "not_in_tier" };
    const r2 = evaluateConditions(set([{ type: "max_vix", value: 30 }]), ev, state(), late);
    expect(r2.perItem[0]!.reasons[0]!.code).toBe("CONTEXT_FIELD_NOT_IN_TIER");
    expect(blockersFromEvaluation(r2)[0]!.userActionRequired).toBe(true);
  });
  it("max_vix：值 > 上限 → UNSATISFIED(VOL_REGIME_EXCEEDED)，nextCheckAt 未知 = null；CV-D12 字符串比较前转数值", () => {
    const ev = evidenceAt(NOW, { overrides: { vix: "31.2" } });
    const r = evaluateConditions(set([{ type: "max_vix", value: 30 }]), ev, state(), NOW);
    expect(r.perItem[0]).toMatchObject({ outcome: "UNSATISFIED", reasons: [{ code: "VOL_REGIME_EXCEEDED", detail: { value: 31.2, max: 30 } }], nextCheckAt: null });
    expect(r.nextCheckAt).toBeNull();
  });
});

describe("K-04 交易日间隔：跨周末 / 假日 / 提前收盘", () => {
  const items: Condition[] = [{ type: "min_gap_trading_days", days: 1 }];
  it("K-04 周五确认 → 周六/周日不满足，周一满足；nextCheckAt = 周一 09:30 ET", () => {
    const st = state({ lastConfirmedStepAt: "2026-09-18T15:30:00.000Z" });
    const sat = evaluateConditions(set(items), emptyConditionEvidence(), st, "2026-09-19T15:00:00.000Z");
    expect(sat.perItem[0]).toMatchObject({ outcome: "UNSATISFIED", reasons: [{ code: "STEP_GAP_NOT_ELAPSED", detail: { eligibleTradingDate: "2026-09-21" } }], nextCheckAt: "2026-09-21T13:30:00.000Z" });
    expect(evaluateConditions(set(items), emptyConditionEvidence(), st, "2026-09-21T14:00:00.000Z").outcome).toBe("SATISFIED");
    // 同日再来一步：不满足
    expect(evaluateConditions(set(items), emptyConditionEvidence(), st, "2026-09-18T18:00:00.000Z").outcome).toBe("UNSATISFIED");
  });
  it("K-04 假日：9/4（周五）确认 → 9/7 Labor Day 不算交易日 → 9/8 才可；感恩节次日半日市仍算交易日", () => {
    expect(NYSE_CALENDAR.holidays.has("2026-09-07")).toBe(true);
    const st = state({ lastConfirmedStepAt: "2026-09-04T15:00:00.000Z" });
    const mon = evaluateConditions(set(items), emptyConditionEvidence(), st, "2026-09-07T15:00:00.000Z");
    expect(mon.perItem[0]).toMatchObject({ outcome: "UNSATISFIED", nextCheckAt: "2026-09-08T13:30:00.000Z" });
    expect(evaluateConditions(set(items), emptyConditionEvidence(), st, "2026-09-08T14:00:00.000Z").outcome).toBe("SATISFIED");
    const thanks = state({ lastConfirmedStepAt: "2026-11-25T18:00:00.000Z" }); // 周三
    const fri = evaluateConditions(set(items), emptyConditionEvidence(), thanks, "2026-11-27T15:00:00.000Z"); // 周五半日市
    expect(fri.outcome).toBe("SATISFIED");
    const thu = evaluateConditions(set(items), emptyConditionEvidence(), thanks, "2026-11-26T15:00:00.000Z"); // 感恩节
    expect(thu.perItem[0]!.nextCheckAt).toBe("2026-11-27T14:30:00.000Z"); // 半日市开盘 09:30 EST
  });
  it("session 条件：半日市 13:00 ET 后 → SESSION_RULE_BLOCK，nextCheckAt = 下一交易日开盘", () => {
    const r = evaluateConditions(set([{ type: "session", allow: ["US_REGULAR"] }]), emptyConditionEvidence(), state(), "2026-11-27T18:30:00.000Z"); // 13:30 EST
    expect(r.perItem[0]).toMatchObject({ outcome: "UNSATISFIED", reasons: [{ code: "SESSION_RULE_BLOCK" }], nextCheckAt: "2026-11-30T14:30:00.000Z" });
  });
});

describe("K-05 事件窗口边界与 day 精度整日等待", () => {
  const cond: Condition = { type: "avoid_event_window", kinds: ["MACRO_TIER1"], beforeMin: 30, afterMin: 20, includeEstimated: true, wholeDayIfDayPrecision: true };
  it("K-05 exact：[T−30min, T+20min) 内阻塞，边界外放行；nextCheckAt = 窗口结束", () => {
    const events = [fixtureEvent({ dateLocal: "2026-09-18", scheduledAtUtc: "2026-09-18T15:10:00.000Z" })];
    const inWin = evaluateConditions(set([cond]), evidenceAt(NOW, {}, events), state(), NOW);
    expect(inWin.perItem[0]).toMatchObject({ outcome: "UNSATISFIED", reasons: [{ code: "EVENT_WINDOW_ACTIVE" }], nextCheckAt: "2026-09-18T15:30:00.000Z" });
    const before = evaluateConditions(set([cond]), evidenceAt("2026-09-18T14:39:59.000Z", {}, events), state(), "2026-09-18T14:39:59.000Z");
    expect(before.outcome).toBe("SATISFIED");
    const atEnd = evaluateConditions(set([cond]), evidenceAt("2026-09-18T15:30:00.000Z", {}, events), state(), "2026-09-18T15:30:00.000Z");
    expect(atEnd.outcome).toBe("SATISFIED");
  });
  it("K-05 day 精度 + 预选整日等待 → 整日 UNSATISFIED（纽约当地日 + 前后缓冲）；未预选 → INSUFFICIENT(EVENT_DATE_UNCERTAIN, userActionRequired)", () => {
    const events = [fixtureEvent({ dateLocal: "2026-09-18", datePrecision: "day" })];
    const whole = evaluateConditions(set([cond]), evidenceAt(NOW, {}, events), state(), NOW);
    expect(whole.perItem[0]).toMatchObject({ outcome: "UNSATISFIED", reasons: [{ code: "EVENT_WINDOW_ACTIVE", detail: { window: "whole_day" } }], nextCheckAt: "2026-09-19T04:20:00.000Z" });
    const noPick = evaluateConditions(set([{ ...cond, wholeDayIfDayPrecision: false }]), evidenceAt(NOW, {}, events), state(), NOW);
    expect(noPick.perItem[0]).toMatchObject({ outcome: "INSUFFICIENT_EVIDENCE", reasons: [{ code: "EVENT_DATE_UNCERTAIN" }] });
    expect(blockersFromEvaluation(noPick)[0]!.userActionRequired).toBe(true);
    // 另一天的 day 事件不影响今天
    const other = evaluateConditions(set([cond]), evidenceAt(NOW, {}, [fixtureEvent({ dateLocal: "2026-09-21", datePrecision: "day" })]), state(), NOW);
    expect(other.outcome).toBe("SATISFIED");
  });
  it("K-05 cancelled 事件与不含估计的估计事件被忽略；不相关公司事件不算", () => {
    const events = [fixtureEvent({ dateLocal: "2026-09-18", scheduledAtUtc: "2026-09-18T15:10:00.000Z", status: "cancelled" }), fixtureEvent({ dateLocal: "2026-09-18", scheduledAtUtc: "2026-09-18T15:10:00.000Z", status: "estimated", datePrecision: "estimate", name: "est" })];
    expect(evaluateConditions(set([{ ...cond, includeEstimated: false }]), evidenceAt(NOW, {}, events), state(), NOW).outcome).toBe("SATISFIED");
  });
});

describe("K-06 earnings_window：前 / 后 / 需常规时段与实时参考", () => {
  const cond: Condition = { type: "earnings_window", beforeTradingDays: 1, afterSessions: 1, requireRegularSessionAfter: true, requireLiveReferenceAfter: true };
  it("K-06 前窗：财报在明天（1 个交易日内）→ EARNINGS_WINDOW_ACTIVE(before)，nextCheckAt = 财报时刻；两个交易日外放行", () => {
    const tomorrow = [fixtureEvent({ kind: "EARNINGS", dateLocal: "2026-09-21", underlyingIds: [U], sessionHint: "amc", name: "q3" })];
    const r = evaluateConditions(set([cond]), evidenceAt(NOW, {}, tomorrow), state(), NOW);
    expect(r.perItem[0]).toMatchObject({ outcome: "UNSATISFIED", reasons: [{ code: "EARNINGS_WINDOW_ACTIVE", detail: { phase: "before" } }], nextCheckAt: "2026-09-21T20:00:00.000Z" });
    const later = [fixtureEvent({ kind: "EARNINGS", dateLocal: "2026-09-23", underlyingIds: [U], sessionHint: "amc", name: "q3" })];
    expect(evaluateConditions(set([cond]), evidenceAt(NOW, {}, later), state(), NOW).outcome).toBe("SATISFIED");
  });
  it("K-06 后窗：周四盘后财报 → 周五盘中 1 个常规时段未完成 → 等；周一常规时段 + 实时参考 → 放行；无实时参考 → INSUFFICIENT(REFERENCE_MISSING)", () => {
    const thu = [fixtureEvent({ kind: "EARNINGS", dateLocal: "2026-09-17", underlyingIds: [U], sessionHint: "amc", name: "q3" })];
    const fri = evaluateConditions(set([cond]), evidenceAt(NOW, {}, thu), state(), NOW);
    expect(fri.perItem[0]).toMatchObject({ outcome: "UNSATISFIED", reasons: [{ code: "EARNINGS_WINDOW_ACTIVE", detail: { phase: "after", sessionsCompleted: 0 } }], nextCheckAt: "2026-09-18T20:00:00.000Z" });
    const monPre = "2026-09-21T12:00:00.000Z"; // 周一 08:00 ET 盘前
    const pre = evaluateConditions(set([cond]), evidenceAt(monPre, {}, thu), state(), monPre);
    expect(pre.perItem[0]).toMatchObject({ outcome: "UNSATISFIED", reasons: [{ code: "EARNINGS_WINDOW_ACTIVE", detail: { reason: "regular_session_required" } }], nextCheckAt: "2026-09-21T13:30:00.000Z" });
    const mon = "2026-09-21T15:00:00.000Z";
    const noRef = evaluateConditions(set([cond]), evidenceAt(mon, {}, thu), state(), mon);
    expect(noRef.perItem[0]).toMatchObject({ outcome: "INSUFFICIENT_EVIDENCE", reasons: [{ code: "REFERENCE_MISSING" }] });
    const withRef = { ...evidenceAt(mon, {}, thu), quote: { evidenceIds: ["ev_q"], executableUsdPerShare: "251", referencePriceUsd: "250", referenceKind: "live" as const, premiumBps: 40 } };
    expect(evaluateConditions(set([cond]), withRef, state(), mon).outcome).toBe("SATISFIED");
  });
  it("K-06 财报覆盖未知 → INSUFFICIENT(EARNINGS_COVERAGE_UNKNOWN)", () => {
    const ev = evidenceAt(NOW);
    ev.earningsCoverage = {};
    expect(evaluateConditions(set([cond]), ev, state(), NOW).perItem[0]).toMatchObject({ outcome: "INSUFFICIENT_EVIDENCE", reasons: [{ code: "EARNINGS_COVERAGE_UNKNOWN" }] });
  });
});

describe("K-07 not_in_fed_blackout：默认不在模板，且不影响其它条件", () => {
  it("K-07 模板目录里没有 not_in_fed_blackout；用户显式加入才生效；blackout=true 时其它条件结果不变", () => {
    expect(validatePlaybookCatalog({ version: "playbooks/1.0.0", playbooks: { session_dca: { id: "session_dca", side: "buy", conditions: [{ type: "not_in_fed_blackout" }], simulationAllowed: true }, event_aware_accumulate: { id: "event_aware_accumulate", side: "buy", conditions: [], simulationAllowed: true }, discount_watch: { id: "discount_watch", side: "buy", conditions: [], simulationAllowed: true }, target_sell: { id: "target_sell", side: "sell", conditions: [], simulationAllowed: true }, portfolio_rebalance: { id: "portfolio_rebalance", side: "buy", conditions: [], simulationAllowed: true } } }).ok).toBe(false);
    const ev = evidenceAt(NOW, { overrides: { blackout: true, blackoutUntil: "2026-09-25T00:00:00.000Z" } });
    const without = evaluateConditions(set([{ type: "session", allow: ["US_REGULAR"] }, { type: "max_vix", value: 30 }]), ev, state(), NOW);
    expect(without.outcome).toBe("SATISFIED");
    const withFed = evaluateConditions(set([{ type: "session", allow: ["US_REGULAR"] }, { type: "max_vix", value: 30 }, { type: "not_in_fed_blackout" }]), ev, state(), NOW);
    expect(withFed.perItem.slice(0, 2).map((p) => p.outcome)).toEqual(["SATISFIED", "SATISFIED"]);
    expect(withFed.perItem[2]).toMatchObject({ outcome: "UNSATISFIED", reasons: [{ code: "FED_BLACKOUT" }], nextCheckAt: "2026-09-25T00:00:00.000Z" });
  });
});

describe("K-08 跨资产确认不接受 undecided", () => {
  it("K-08 DSL 拒绝 acceptStates 含 undecided / 空集；求值：undecided → UNSATISFIED，relief 在 accept 内 → SATISFIED，value=null → INSUFFICIENT", () => {
    expect(validateConditionSet({ items: [{ type: "require_cross_asset_confirmation", acceptStates: ["relief", "undecided"] }] }, "LIVE").ok).toBe(false);
    expect(validateConditionSet({ items: [{ type: "require_cross_asset_confirmation", acceptStates: [] }] }, "LIVE").ok).toBe(false);
    const cond: Condition = { type: "require_cross_asset_confirmation", acceptStates: ["relief", "transmission"] };
    const und = evidenceAt(NOW, { overrides: { crossAsset: { eventId: "e1", state: "undecided", atUtc: NOW } } });
    expect(evaluateConditions(set([cond]), und, state(), NOW).perItem[0]).toMatchObject({ outcome: "UNSATISFIED", reasons: [{ code: "CROSS_ASSET_UNCONFIRMED" }] });
    const ok = evidenceAt(NOW, { overrides: { crossAsset: { eventId: "e1", state: "relief", atUtc: NOW } } });
    expect(evaluateConditions(set([cond]), ok, state(), NOW).outcome).toBe("SATISFIED");
    expect(evaluateConditions(set([cond]), evidenceAt(NOW), state(), NOW).perItem[0]!.outcome).toBe("INSUFFICIENT_EVIDENCE");
  });
});

describe("Y-05 / DSL 校验", () => {
  it("Y-05 premium_bps_lte 收盘口径：LIVE 拒绝，SIMULATION 允许；liveOnlyForExecution 必须为 true", () => {
    const close = { type: "premium_bps_lte", value: -50, referenceKind: "official_close", liveOnlyForExecution: true };
    const live = validateConditionSet({ items: [close] }, "LIVE");
    expect(live.ok).toBe(false);
    if (!live.ok) expect(live.errors[0]!.code).toBe("close_reference_not_allowed_for_live_execution");
    expect(validateConditionSet({ items: [close] }, "SIMULATION").ok).toBe(true);
    expect(validateConditionSet({ items: [{ ...close, referenceKind: "live" }] }, "LIVE").ok).toBe(true);
    expect(validateConditionSet({ items: [{ ...close, referenceKind: "live", liveOnlyForExecution: false }] }, "LIVE").ok).toBe(false);
  });
  it("premium：口径不符 → INSUFFICIENT(REFERENCE_STALE)；溢价超阈值 → PREMIUM_CONDITION_NOT_MET；满足 → SATISFIED", () => {
    const cond: Condition = { type: "premium_bps_lte", value: 20, referenceKind: "live", liveOnlyForExecution: true };
    const closeQuote = { ...emptyConditionEvidence(), quote: { evidenceIds: ["q"], executableUsdPerShare: "250", referencePriceUsd: "250", referenceKind: "official_close" as const, premiumBps: 0 } };
    expect(evaluateConditions(set([cond]), closeQuote, state(), NOW).perItem[0]).toMatchObject({ outcome: "INSUFFICIENT_EVIDENCE", reasons: [{ code: "REFERENCE_STALE" }] });
    const high = { ...emptyConditionEvidence(), quote: { evidenceIds: ["q"], executableUsdPerShare: "252", referencePriceUsd: "250", referenceKind: "live" as const, premiumBps: 80 } };
    expect(evaluateConditions(set([cond]), high, state(), NOW).perItem[0]).toMatchObject({ outcome: "UNSATISFIED", reasons: [{ code: "PREMIUM_CONDITION_NOT_MET" }] });
    const ok = { ...high, quote: { ...high.quote, premiumBps: 10 } };
    expect(evaluateConditions(set([cond]), ok, state(), NOW).outcome).toBe("SATISFIED");
    expect(evaluateConditions(set([cond]), emptyConditionEvidence(), state(), NOW).perItem[0]!.reasons[0]!.code).toBe("QUOTE_UNAVAILABLE");
  });
  it("Y-06 tracked_cost：覆盖率 < 100% → INSUFFICIENT(TRACKED_COST_UNKNOWN, userActionRequired)；target_price 独立可用", () => {
    const items: Condition[] = [{ type: "tracked_cost_pnl_pct_gte", value: 10 }, { type: "target_price_gte", underlyingPriceUsd: "240", referenceKind: "live" }];
    const ev: ConditionEvidence = { ...emptyConditionEvidence(), quote: { evidenceIds: ["q"], executableUsdPerShare: "251", referencePriceUsd: "250", referenceKind: "live", premiumBps: 40 }, trackedCost: { "eip155:196:0x2222222222222222222222222222222222222222": { coverageBps: 6000, avgCostUsdPerShare: "200", evidenceId: "c" } } };
    const r = evaluateConditions(set(items), ev, state(), NOW);
    expect(r.perItem[0]).toMatchObject({ outcome: "INSUFFICIENT_EVIDENCE", reasons: [{ code: "TRACKED_COST_UNKNOWN" }] });
    expect(r.perItem[1]!.outcome).toBe("SATISFIED");
    expect(blockersFromEvaluation(r).find((b) => b.code === "TRACKED_COST_UNKNOWN")!.userActionRequired).toBe(true);
    ev.trackedCost["eip155:196:0x2222222222222222222222222222222222222222"]!.coverageBps = 10_000;
    expect(evaluateConditions(set(items), ev, state(), NOW).outcome).toBe("SATISFIED"); // (250−200)/200 = 25% ≥ 10
  });
  it("cash_floor：余额未知 → INSUFFICIENT；余额−本步 < 下限 → UNSATISFIED；nextCheckAt 恒为 null", () => {
    const cond: Condition = { type: "cash_floor", inputAssetKey: "eip155:196:0x1111111111111111111111111111111111111111", floorRaw: "10000000" };
    expect(evaluateConditions(set([cond]), emptyConditionEvidence(), state(), NOW).perItem[0]).toMatchObject({ outcome: "INSUFFICIENT_EVIDENCE", nextCheckAt: null });
    const low = { ...emptyConditionEvidence(), balances: { [cond.inputAssetKey]: { balanceRaw: "12000000", evidenceId: "b" } } };
    expect(evaluateConditions(set([cond]), low, state({ nextStepAmountRaw: "5000000" }), NOW).perItem[0]).toMatchObject({ outcome: "UNSATISFIED", reasons: [{ code: "CASH_FLOOR_BLOCK" }], nextCheckAt: null });
    expect(evaluateConditions(set([cond]), low, state({ nextStepAmountRaw: "1000000" }), NOW).outcome).toBe("SATISFIED");
  });
  it("max_steps_per_trading_day：task 作用域按已确认步数；budget_group 未知 → INSUFFICIENT", () => {
    const task: Condition = { type: "max_steps_per_trading_day", value: 1, scope: "task" };
    expect(evaluateConditions(set([task]), emptyConditionEvidence(), state({ stepsConfirmedToday: 1 }), NOW).perItem[0]).toMatchObject({ outcome: "UNSATISFIED", reasons: [{ code: "DAILY_STEP_CAP_REACHED" }], nextCheckAt: "2026-09-21T13:30:00.000Z" });
    const group: Condition = { type: "max_steps_per_trading_day", value: 2, scope: "budget_group" };
    expect(evaluateConditions(set([group]), emptyConditionEvidence(), state(), NOW).perItem[0]!.outcome).toBe("INSUFFICIENT_EVIDENCE");
  });
});

describe("T-06 thesis_holds 联动", () => {
  it("T-06 holds → SATISFIED；invalidated → THESIS_INVALIDATED；unknown → INSUFFICIENT(THESIS_UNKNOWN)；expired → THESIS_EXPIRED；未加载 → INSUFFICIENT", () => {
    const cond: Condition = { type: "thesis_holds", thesisId: "ths_1" };
    const with_ = (status: "holds" | "invalidated" | "unknown" | "expired") => ({ ...emptyConditionEvidence(), theses: { ths_1: { status, evidenceIds: ["t"] } } });
    expect(evaluateConditions(set([cond]), with_("holds"), state(), NOW).outcome).toBe("SATISFIED");
    expect(evaluateConditions(set([cond]), with_("invalidated"), state(), NOW).perItem[0]).toMatchObject({ outcome: "UNSATISFIED", reasons: [{ code: "THESIS_INVALIDATED" }] });
    expect(evaluateConditions(set([cond]), with_("unknown"), state(), NOW).perItem[0]).toMatchObject({ outcome: "INSUFFICIENT_EVIDENCE", reasons: [{ code: "THESIS_UNKNOWN" }] });
    expect(evaluateConditions(set([cond]), with_("expired"), state(), NOW).perItem[0]).toMatchObject({ outcome: "UNSATISFIED", reasons: [{ code: "THESIS_EXPIRED" }] });
    expect(evaluateConditions(set([cond]), emptyConditionEvidence(), state(), NOW).perItem[0]!.outcome).toBe("INSUFFICIENT_EVIDENCE");
  });
});

describe("nextCheckAt 取各项已知恢复点的最小值；全部未知 → null", () => {
  it("事件窗口结束 15:30 vs 下一常规时段开盘：取最小；cash_floor 不贡献", () => {
    const items: Condition[] = [{ type: "avoid_event_window", kinds: ["MACRO_TIER1"], beforeMin: 30, afterMin: 20, includeEstimated: true, wholeDayIfDayPrecision: true }, { type: "cash_floor", inputAssetKey: "eip155:196:0x1111111111111111111111111111111111111111", floorRaw: "1" }, { type: "max_steps_per_trading_day", value: 1, scope: "task" }];
    const ev = evidenceAt(NOW, {}, [fixtureEvent({ dateLocal: "2026-09-18", scheduledAtUtc: "2026-09-18T15:10:00.000Z" })]);
    const r = evaluateConditions(set(items), ev, state({ stepsConfirmedToday: 1 }), NOW);
    expect(r.nextCheckAt).toBe("2026-09-18T15:30:00.000Z");
    expect(evaluateConditions(set([items[1]!]), emptyConditionEvidence(), state(), NOW).nextCheckAt).toBeNull();
  });
});
