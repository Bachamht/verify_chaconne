/**
 * `evaluateConditions(set, evidence, taskState, now) → ConditionEvaluation`（interfaces §11.4）——纯函数。
 *
 * 三态：SATISFIED / UNSATISFIED / INSUFFICIENT_EVIDENCE；后两者都不签发证书（K-03：证据不足一律等待，不伪装）。
 * nextCheckAt：各项已知恢复点的最小值（事件窗口结束、下一常规时段开盘、下一交易日）；未知（cash_floor、目标价、溢价、波动率）写 null。
 * 交易日按 calendar.ts；`min_gap_trading_days` 以上一步**确认**的交易日计。
 * 同输入同结果（K-01）：没有 Date.now()、没有随机；perItem 顺序 = items 顺序。
 */
import { NYSE_CALENDAR, type MarketCalendar } from "../../calendar";
import { deviationBps } from "../amounts";
import type { Condition, ConditionEvaluation, ConditionItemResult, ConditionOutcome, ConditionSet, CtxField, CtxStatus, IsoUtc, MarketEvent, Reason, ReasonCode } from "../contracts";
import { contextField } from "../context/schema";
import { eventWindow, eventRelevantTo } from "../events/events";
import { addTradingDays, isNyTradingDate, nextRegularOpenMs, nextTradingDay, nyDateAt, regularCloseMs, regularOpenMs, regularSessionsCompletedSince, sessionLabelAtMs, tradingDaysBetweenDates, zonedLocalToUtcMs, NY_TZ } from "./calendarUtil";
import { conditionsHash } from "./hash";
import type { ConditionEvidence, TaskConditionState } from "./types";

const iso = (ms: number): IsoUtc => new Date(ms).toISOString();

interface ItemCtx {
  ev: ConditionEvidence;
  st: TaskConditionState;
  nowMs: number;
  cal: MarketCalendar;
}

function reason(code: ReasonCode, evidenceIds: string[], detail?: Reason["detail"]): Reason {
  return detail ? { code, severity: "block", evidenceIds, detail } : { code, severity: "block", evidenceIds };
}

function result(item: Condition, outcome: ConditionOutcome, reasons: Reason[], evidenceIds: string[], nextCheckAt: IsoUtc | null): ConditionItemResult {
  return { item, outcome, reasons, evidenceIds: [...new Set(evidenceIds)].sort(), nextCheckAt };
}

/** 取上下文字段：不可达 → CONTEXT_UNAVAILABLE；not_in_tier → CONTEXT_FIELD_NOT_IN_TIER；stale/unfinished/unavailable → CONTEXT_STALE/UNAVAILABLE */
function ctxField(c: ItemCtx, path: string): { field: CtxField<unknown>; evidenceId: string } | { blocked: Reason } {
  if (!c.ev.context) return { blocked: reason("CONTEXT_UNAVAILABLE", [], { field: path }) };
  const f = contextField(c.ev.context.snapshot, path);
  const status: CtxStatus | undefined = c.ev.context.fieldStatus[path] ?? f?.status;
  const id = c.ev.context.evidenceId;
  if (!f) return { blocked: reason("CONTEXT_UNAVAILABLE", [id], { field: path, reason: "missing" }) };
  if (f.note === "not_in_tier") return { blocked: reason("CONTEXT_FIELD_NOT_IN_TIER", [id], { field: path }) };
  if (status === "stale" || status === "unfinished") return { blocked: reason("CONTEXT_STALE", [id], { field: path, status: status ?? null, observedAt: f.observedAt, fetchedAt: f.fetchedAt }) };
  if (status !== "ok" || f.value === null) return { blocked: reason("CONTEXT_UNAVAILABLE", [id], { field: path, status: status ?? null }) };
  return { field: f, evidenceId: id };
}

function eventsAvailable(c: ItemCtx): Reason | null {
  if (!c.ev.context) return reason("CONTEXT_UNAVAILABLE", [], { field: "events" });
  const s = c.ev.context.fieldStatus["events"];
  if (s === "stale") return reason("CONTEXT_STALE", [c.ev.context.evidenceId], { field: "events" });
  return null;
}

/* ---------------- 各条件 ---------------- */

function evalSession(item: Extract<Condition, { type: "session" }>, c: ItemCtx): ConditionItemResult {
  const label = sessionLabelAtMs(c.nowMs, c.cal);
  if (label !== "CLOSED" && item.allow.includes(label)) return result(item, "SATISFIED", [], [], null);
  // 下一次允许时段的开始：只推导常规时段（PRE/POST 的开始时刻同样可算，这里按最早的允许时段）
  const today = nyDateAt(c.nowMs);
  const candidates: number[] = [];
  const dayStarts = (d: string) => {
    if (item.allow.includes("US_PRE")) candidates.push(zonedLocalToUtcMs(NY_TZ, d, 4 * 60));
    if (item.allow.includes("US_REGULAR")) candidates.push(regularOpenMs(d));
    if (item.allow.includes("US_POST")) candidates.push(regularCloseMs(d, c.cal));
  };
  if (isNyTradingDate(today, c.cal)) dayStarts(today);
  dayStarts(nextTradingDay(today, false, c.cal));
  const next = candidates.filter((t) => t > c.nowMs).sort((a, b) => a - b)[0] ?? null;
  return result(item, "UNSATISFIED", [reason("SESSION_RULE_BLOCK", [], { session: label, allow: item.allow.join("|") })], [], next === null ? null : iso(next));
}

function evalAvoidEventWindow(item: Extract<Condition, { type: "avoid_event_window" }>, c: ItemCtx): ConditionItemResult {
  const unavailable = eventsAvailable(c);
  if (unavailable) return result(item, "INSUFFICIENT_EVIDENCE", [unavailable], unavailable.evidenceIds, null);
  const reasons: Reason[] = [];
  const ids: string[] = [];
  let next: number | null = null;
  let uncertain = false;
  for (const { event, evidenceId } of c.ev.events) {
    if (!item.kinds.includes(event.kind)) continue;
    if (!eventRelevantTo(event, c.st.underlyingIds)) continue;
    const w = eventWindow(event, item);
    if (w.kind === "ignored") continue;
    if (w.kind === "uncertain") {
      if (c.nowMs >= w.dayFromMs && c.nowMs < w.dayToMs) {
        uncertain = true;
        reasons.push(reason("EVENT_DATE_UNCERTAIN", [evidenceId], { eventId: event.id, dateLocal: event.dateLocal, datePrecision: event.datePrecision }));
        ids.push(evidenceId);
        next = next === null ? w.dayToMs : Math.min(next, w.dayToMs);
      }
      continue;
    }
    if (c.nowMs >= w.fromMs && c.nowMs < w.toMs) {
      reasons.push(reason("EVENT_WINDOW_ACTIVE", [evidenceId], { eventId: event.id, kind: event.kind, window: w.kind, from: iso(w.fromMs), to: iso(w.toMs), revision: event.revision }));
      ids.push(evidenceId);
      next = next === null ? w.toMs : Math.min(next, w.toMs);
    }
  }
  if (reasons.length === 0) return result(item, "SATISFIED", [], c.ev.context ? [c.ev.context.evidenceId] : [], null);
  const outcome: ConditionOutcome = reasons.every((r) => r.code === "EVENT_DATE_UNCERTAIN") && uncertain ? "INSUFFICIENT_EVIDENCE" : "UNSATISFIED";
  return result(item, outcome, reasons, ids, next === null ? null : iso(next));
}

/** 财报事件的“发生时刻”：exact → scheduledAtUtc；否则按 sessionHint（bmo = 当日开盘前 = 上一交易日收盘后；amc = 当日收盘；dmh = 当日开盘） */
function earningsMomentMs(ev: MarketEvent, cal: MarketCalendar): number | null {
  if (ev.datePrecision === "exact" && ev.scheduledAtUtc) return Date.parse(ev.scheduledAtUtc);
  if (ev.datePrecision === "estimate") return null;
  if (ev.sessionHint === "amc") return regularCloseMs(ev.dateLocal, cal);
  if (ev.sessionHint === "dmh") return regularOpenMs(ev.dateLocal);
  if (ev.sessionHint === "bmo") return regularOpenMs(ev.dateLocal) - 1;
  return null;
}

function evalEarningsWindow(item: Extract<Condition, { type: "earnings_window" }>, c: ItemCtx): ConditionItemResult {
  const unavailable = eventsAvailable(c);
  if (unavailable) return result(item, "INSUFFICIENT_EVIDENCE", [unavailable], unavailable.evidenceIds, null);
  const reasons: Reason[] = [];
  const ids: string[] = [];
  let next: number | null = null;
  const today = nyDateAt(c.nowMs);
  for (const u of c.st.underlyingIds) {
    if (c.ev.earningsCoverage[u] === undefined) {
      reasons.push(reason("EARNINGS_COVERAGE_UNKNOWN", [], { underlyingId: u }));
      continue;
    }
    if (c.ev.earningsCoverage[u] === false) {
      reasons.push(reason("EARNINGS_COVERAGE_UNKNOWN", [], { underlyingId: u, reason: "not_covered" }));
      continue;
    }
    for (const { event, evidenceId } of c.ev.events) {
      if (event.kind !== "EARNINGS" || event.status === "cancelled" || !event.underlyingIds.includes(u)) continue;
      // 前窗：事件日在 [今天, 今天 + beforeTradingDays] 个交易日内
      if (event.dateLocal >= today) {
        const gap = tradingDaysBetweenDates(today, event.dateLocal, c.cal);
        if (gap <= item.beforeTradingDays) {
          const moment = earningsMomentMs(event, c.cal);
          const passesAt = moment === null ? null : moment;
          reasons.push(reason("EARNINGS_WINDOW_ACTIVE", [evidenceId], { underlyingId: u, eventId: event.id, phase: "before", dateLocal: event.dateLocal, datePrecision: event.datePrecision, status: event.status }));
          ids.push(evidenceId);
          if (passesAt !== null && passesAt > c.nowMs) next = next === null ? passesAt : Math.min(next, passesAt);
          if (event.datePrecision !== "exact" && event.status === "estimated") reasons.push(reason("EVENT_DATE_UNCERTAIN", [evidenceId], { eventId: event.id, datePrecision: event.datePrecision }));
          continue;
        }
      }
      // 后窗：事件已发生，需 afterSessions 个常规时段完成
      const moment = earningsMomentMs(event, c.cal);
      if (moment === null || moment > c.nowMs) continue;
      const done = regularSessionsCompletedSince(moment, c.nowMs, c.cal);
      const recent = tradingDaysBetweenDates(event.dateLocal, today, c.cal) <= item.afterSessions + 2;
      if (!recent) continue;
      if (done < item.afterSessions) {
        reasons.push(reason("EARNINGS_WINDOW_ACTIVE", [evidenceId], { underlyingId: u, eventId: event.id, phase: "after", sessionsCompleted: done, sessionsRequired: item.afterSessions }));
        ids.push(evidenceId);
        // 第 afterSessions 个常规时段的收盘
        let d = nyDateAt(moment);
        let count = 0;
        for (let i = 0; i < 60 && count < item.afterSessions; i++) {
          if (isNyTradingDate(d, c.cal) && regularCloseMs(d, c.cal) > moment) count++;
          if (count < item.afterSessions) d = nextTradingDay(d, false, c.cal);
        }
        const at = regularCloseMs(d, c.cal);
        next = next === null ? at : Math.min(next, at);
        continue;
      }
      if (item.requireRegularSessionAfter && sessionLabelAtMs(c.nowMs, c.cal) !== "US_REGULAR") {
        reasons.push(reason("EARNINGS_WINDOW_ACTIVE", [evidenceId], { underlyingId: u, eventId: event.id, phase: "after", reason: "regular_session_required" }));
        ids.push(evidenceId);
        const at = nextRegularOpenMs(c.nowMs, c.cal);
        next = next === null ? at : Math.min(next, at);
        continue;
      }
      if (item.requireLiveReferenceAfter) {
        const q = c.ev.quote;
        if (!q || q.referencePriceUsd === null || q.referenceKind !== "live") {
          reasons.push(reason("REFERENCE_MISSING", q ? q.evidenceIds : [], { underlyingId: u, eventId: event.id, phase: "after", need: "live", have: q?.referenceKind ?? null }));
          if (q) ids.push(...q.evidenceIds);
        }
      }
    }
  }
  if (reasons.length === 0) return result(item, "SATISFIED", [], c.ev.context ? [c.ev.context.evidenceId] : [], null);
  const insufficient = reasons.every((r) => r.code === "EARNINGS_COVERAGE_UNKNOWN" || r.code === "REFERENCE_MISSING" || r.code === "EVENT_DATE_UNCERTAIN");
  return result(item, insufficient ? "INSUFFICIENT_EVIDENCE" : "UNSATISFIED", reasons, ids, next === null ? null : iso(next));
}

function evalFedBlackout(item: Extract<Condition, { type: "not_in_fed_blackout" }>, c: ItemCtx): ConditionItemResult {
  const f = ctxField(c, "fed.blackout");
  if ("blocked" in f) return result(item, "INSUFFICIENT_EVIDENCE", [f.blocked], f.blocked.evidenceIds, null);
  if (f.field.value !== true) return result(item, "SATISFIED", [], [f.evidenceId], null);
  const until = ctxField(c, "fed.blackoutUntil");
  const next = "blocked" in until ? null : typeof until.field.value === "string" && !Number.isNaN(Date.parse(until.field.value)) ? until.field.value : null;
  return result(item, "UNSATISFIED", [reason("FED_BLACKOUT", [f.evidenceId], { blackoutUntil: next })], [f.evidenceId], next);
}

function evalMaxNumber(item: Extract<Condition, { type: "max_vix" | "max_move" }>, path: string, code: ReasonCode, c: ItemCtx): ConditionItemResult {
  const f = ctxField(c, path);
  if ("blocked" in f) return result(item, "INSUFFICIENT_EVIDENCE", [f.blocked], f.blocked.evidenceIds, null);
  // CV-D12：数值字段是十进制字符串；解析失败 = 证据不足
  const v = Number(f.field.value);
  if (!Number.isFinite(v)) return result(item, "INSUFFICIENT_EVIDENCE", [reason("CONTEXT_UNAVAILABLE", [f.evidenceId], { field: path, reason: "not_numeric" })], [f.evidenceId], null);
  if (v <= item.value) return result(item, "SATISFIED", [], [f.evidenceId], null);
  return result(item, "UNSATISFIED", [reason(code, [f.evidenceId], { field: path, value: v, max: item.value, observedAt: f.field.observedAt })], [f.evidenceId], null);
}

function evalPremium(item: Extract<Condition, { type: "premium_bps_lte" }>, c: ItemCtx): ConditionItemResult {
  const q = c.ev.quote;
  if (!q) return result(item, "INSUFFICIENT_EVIDENCE", [reason("QUOTE_UNAVAILABLE", [], { reason: "no_quote_this_round" })], [], null);
  if (q.referencePriceUsd === null || q.referenceKind === null) return result(item, "INSUFFICIENT_EVIDENCE", [reason("REFERENCE_MISSING", q.evidenceIds, { need: item.referenceKind })], q.evidenceIds, null);
  const kindOk = item.referenceKind === "live" ? q.referenceKind === "live" : q.referenceKind === item.referenceKind || q.referenceKind === "official_close" || q.referenceKind === "close_cross_verified";
  if (!kindOk) return result(item, "INSUFFICIENT_EVIDENCE", [reason("REFERENCE_STALE", q.evidenceIds, { need: item.referenceKind, have: q.referenceKind })], q.evidenceIds, null);
  const prem = q.premiumBps ?? (q.executableUsdPerShare ? deviationBps(q.executableUsdPerShare, q.referencePriceUsd) : null);
  if (prem === null) return result(item, "INSUFFICIENT_EVIDENCE", [reason("QUOTE_UNAVAILABLE", q.evidenceIds, { reason: "premium_not_computable" })], q.evidenceIds, null);
  if (prem <= item.value) return result(item, "SATISFIED", [], q.evidenceIds, null);
  return result(item, "UNSATISFIED", [reason("PREMIUM_CONDITION_NOT_MET", q.evidenceIds, { premiumBps: prem, maxBps: item.value, referenceKind: q.referenceKind })], q.evidenceIds, null);
}

function evalMinGap(item: Extract<Condition, { type: "min_gap_trading_days" }>, c: ItemCtx): ConditionItemResult {
  if (!c.st.lastConfirmedStepAt || item.days === 0) return result(item, "SATISFIED", [], [], null);
  const lastDate = nyDateAt(Date.parse(c.st.lastConfirmedStepAt));
  const today = nyDateAt(c.nowMs);
  const gap = tradingDaysBetweenDates(lastDate, today, c.cal);
  if (gap >= item.days && isNyTradingDate(today, c.cal)) return result(item, "SATISFIED", [], [], null);
  if (gap >= item.days) return result(item, "SATISFIED", [], [], null);
  const eligibleDate = addTradingDays(lastDate, item.days, c.cal);
  return result(item, "UNSATISFIED", [reason("STEP_GAP_NOT_ELAPSED", [], { lastConfirmedTradingDate: lastDate, today, tradingDaysElapsed: gap, required: item.days, eligibleTradingDate: eligibleDate })], [], iso(regularOpenMs(eligibleDate)));
}

function evalDailyCap(item: Extract<Condition, { type: "max_steps_per_trading_day" }>, c: ItemCtx): ConditionItemResult {
  const count = item.scope === "task" ? c.st.stepsConfirmedToday : c.st.stepsConfirmedTodayInBudgetGroup;
  const nextDay = iso(regularOpenMs(nextTradingDay(nyDateAt(c.nowMs), false, c.cal)));
  if (count === null) return result(item, "INSUFFICIENT_EVIDENCE", [reason("DAILY_STEP_CAP_REACHED", [], { scope: item.scope, reason: "group_count_unknown" })], [], null);
  if (count < item.value) return result(item, "SATISFIED", [], [], null);
  return result(item, "UNSATISFIED", [reason("DAILY_STEP_CAP_REACHED", [], { scope: item.scope, count, max: item.value })], [], nextDay);
}

function evalCrossAsset(item: Extract<Condition, { type: "require_cross_asset_confirmation" }>, c: ItemCtx): ConditionItemResult {
  const f = ctxField(c, "crossAsset.lastDataRelease");
  if ("blocked" in f) return result(item, "INSUFFICIENT_EVIDENCE", [f.blocked], f.blocked.evidenceIds, null);
  const v = f.field.value as { eventId: string; state: string; atUtc: string };
  if (v.state === "undecided") return result(item, "UNSATISFIED", [reason("CROSS_ASSET_UNCONFIRMED", [f.evidenceId], { state: v.state, eventId: v.eventId, atUtc: v.atUtc, accept: item.acceptStates.join("|") })], [f.evidenceId], null);
  if ((item.acceptStates as string[]).includes(v.state)) return result(item, "SATISFIED", [], [f.evidenceId], null);
  return result(item, "UNSATISFIED", [reason("CROSS_ASSET_UNCONFIRMED", [f.evidenceId], { state: v.state, eventId: v.eventId, accept: item.acceptStates.join("|") })], [f.evidenceId], null);
}

function evalTarget(item: Extract<Condition, { type: "target_price_gte" | "target_price_lte" }>, c: ItemCtx): ConditionItemResult {
  const q = c.ev.quote;
  if (!q || q.referencePriceUsd === null) return result(item, "INSUFFICIENT_EVIDENCE", [reason("REFERENCE_MISSING", q?.evidenceIds ?? [], { need: "live" })], q?.evidenceIds ?? [], null);
  if (q.referenceKind !== "live") return result(item, "INSUFFICIENT_EVIDENCE", [reason("REFERENCE_STALE", q.evidenceIds, { need: "live", have: q.referenceKind })], q.evidenceIds, null);
  const price = Number(q.referencePriceUsd);
  const target = Number(item.underlyingPriceUsd);
  const ok = item.type === "target_price_gte" ? price >= target : price <= target;
  if (ok) return result(item, "SATISFIED", [], q.evidenceIds, null);
  return result(item, "UNSATISFIED", [reason("TARGET_NOT_REACHED", q.evidenceIds, { referencePriceUsd: q.referencePriceUsd, targetUsd: item.underlyingPriceUsd, direction: item.type === "target_price_gte" ? "gte" : "lte" })], q.evidenceIds, null);
}

function evalTrackedCost(item: Extract<Condition, { type: "tracked_cost_pnl_pct_gte" }>, c: ItemCtx): ConditionItemResult {
  const key = c.st.outputAssetKeys[0] ?? "";
  const cost = c.ev.trackedCost[key];
  if (!cost || cost.coverageBps < 10_000 || cost.avgCostUsdPerShare === null) {
    return result(item, "INSUFFICIENT_EVIDENCE", [reason("TRACKED_COST_UNKNOWN", cost ? [cost.evidenceId] : [], { assetKey: key, coverageBps: cost?.coverageBps ?? null, suggestion: "use target_price condition" })], cost ? [cost.evidenceId] : [], null);
  }
  const q = c.ev.quote;
  if (!q || q.referencePriceUsd === null || q.referenceKind !== "live") return result(item, "INSUFFICIENT_EVIDENCE", [reason("REFERENCE_MISSING", q?.evidenceIds ?? [], { need: "live" })], [cost.evidenceId, ...(q?.evidenceIds ?? [])], null);
  const pnlPct = ((Number(q.referencePriceUsd) - Number(cost.avgCostUsdPerShare)) / Number(cost.avgCostUsdPerShare)) * 100;
  const ids = [cost.evidenceId, ...q.evidenceIds];
  if (pnlPct >= item.value) return result(item, "SATISFIED", [], ids, null);
  return result(item, "UNSATISFIED", [reason("TARGET_NOT_REACHED", ids, { pnlPct: Math.round(pnlPct * 100) / 100, minPct: item.value, avgCostUsdPerShare: cost.avgCostUsdPerShare, referencePriceUsd: q.referencePriceUsd })], ids, null);
}

function evalCashFloor(item: Extract<Condition, { type: "cash_floor" }>, c: ItemCtx): ConditionItemResult {
  const bal = c.ev.balances[item.inputAssetKey];
  if (!bal) return result(item, "INSUFFICIENT_EVIDENCE", [reason("CASH_FLOOR_BLOCK", [], { assetKey: item.inputAssetKey, reason: "balance_unknown" })], [], null);
  const spend = c.st.nextStepAmountRaw ? BigInt(c.st.nextStepAmountRaw) : 0n;
  const after = BigInt(bal.balanceRaw) - spend;
  if (after >= BigInt(item.floorRaw)) return result(item, "SATISFIED", [], [bal.evidenceId], null);
  return result(item, "UNSATISFIED", [reason("CASH_FLOOR_BLOCK", [bal.evidenceId], { balanceRaw: bal.balanceRaw, nextStepAmountRaw: c.st.nextStepAmountRaw, floorRaw: item.floorRaw })], [bal.evidenceId], null);
}

function evalThesis(item: Extract<Condition, { type: "thesis_holds" }>, c: ItemCtx): ConditionItemResult {
  const t = c.ev.theses[item.thesisId];
  if (!t) return result(item, "INSUFFICIENT_EVIDENCE", [reason("THESIS_UNKNOWN", [], { thesisId: item.thesisId, reason: "not_loaded" })], [], null);
  switch (t.status) {
    case "holds":
      return result(item, "SATISFIED", [], t.evidenceIds, null);
    case "invalidated":
      return result(item, "UNSATISFIED", [reason("THESIS_INVALIDATED", t.evidenceIds, { thesisId: item.thesisId })], t.evidenceIds, null);
    case "expired":
      return result(item, "UNSATISFIED", [reason("THESIS_EXPIRED", t.evidenceIds, { thesisId: item.thesisId })], t.evidenceIds, null);
    default:
      return result(item, "INSUFFICIENT_EVIDENCE", [reason("THESIS_UNKNOWN", t.evidenceIds, { thesisId: item.thesisId })], t.evidenceIds, null);
  }
}

export function evaluateConditionItem(item: Condition, c: ItemCtx): ConditionItemResult {
  switch (item.type) {
    case "session":
      return evalSession(item, c);
    case "avoid_event_window":
      return evalAvoidEventWindow(item, c);
    case "earnings_window":
      return evalEarningsWindow(item, c);
    case "not_in_fed_blackout":
      return evalFedBlackout(item, c);
    case "max_vix":
      return evalMaxNumber(item, "risk.vix", "VOL_REGIME_EXCEEDED", c);
    case "max_move":
      return evalMaxNumber(item, "rates.move", "VOL_REGIME_EXCEEDED", c);
    case "premium_bps_lte":
      return evalPremium(item, c);
    case "min_gap_trading_days":
      return evalMinGap(item, c);
    case "max_steps_per_trading_day":
      return evalDailyCap(item, c);
    case "require_cross_asset_confirmation":
      return evalCrossAsset(item, c);
    case "target_price_gte":
    case "target_price_lte":
      return evalTarget(item, c);
    case "tracked_cost_pnl_pct_gte":
      return evalTrackedCost(item, c);
    case "cash_floor":
      return evalCashFloor(item, c);
    case "thesis_holds":
      return evalThesis(item, c);
  }
}

export interface EvaluateConditionsOptions {
  calendar?: MarketCalendar;
}

export function evaluateConditions(set: ConditionSet, evidence: ConditionEvidence, taskState: TaskConditionState, now: IsoUtc, opts: EvaluateConditionsOptions = {}): ConditionEvaluation {
  const nowMs = Date.parse(now);
  if (Number.isNaN(nowMs)) throw new Error(`非法 now: ${now}`);
  const c: ItemCtx = { ev: evidence, st: taskState, nowMs, cal: opts.calendar ?? NYSE_CALENDAR };
  const perItem = set.items.map((item) => evaluateConditionItem(item, c));
  let outcome: ConditionOutcome = "SATISFIED";
  if (perItem.some((r) => r.outcome === "UNSATISFIED")) outcome = "UNSATISFIED";
  else if (perItem.some((r) => r.outcome === "INSUFFICIENT_EVIDENCE")) outcome = "INSUFFICIENT_EVIDENCE";
  const nexts = perItem.map((r) => r.nextCheckAt).filter((x): x is string => x !== null).map((x) => Date.parse(x)).filter((x) => x > nowMs);
  const nextCheckAt = nexts.length ? iso(Math.min(...nexts)) : null;
  return { outcome, perItem, nextCheckAt, evaluatedAt: now, conditionsHash: conditionsHash(set.items, set.version) };
}

/** 只求值不依赖报价/参考价的条件（prepare-step 前置快路径：先挡掉肯定不过的，再花钱取报价） */
export const QUOTE_DEPENDENT_CONDITION_TYPES: ReadonlySet<Condition["type"]> = new Set<Condition["type"]>(["premium_bps_lte", "target_price_gte", "target_price_lte", "tracked_cost_pnl_pct_gte"]);
