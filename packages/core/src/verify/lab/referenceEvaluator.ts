/**
 * ⚠ 参考实现（Lane E），合并后由 Lane B 的正式 `evaluateConditions` 替换。
 *
 * 只覆盖四种条件：`session` / `avoid_event_window` / `max_vix` / `min_gap_trading_days`；其余类型一律
 * `INSUFFICIENT_EVIDENCE`（原因 CONTEXT_UNAVAILABLE，detail.unsupportedByReferenceEvaluator=true），绝不放行。
 * 纯函数、确定性：同输入同输出；证据不足 = 等待，不补值。
 */
import type { Condition, ConditionEvaluation, ConditionItemResult, ConditionOutcome, ConditionSet, CtxField, IsoUtc, MarketEvent, Reason, ReasonCode } from "../contracts";
import { NYSE_CALENDAR, type MarketCalendar } from "../../calendar";
import type { ConditionEvaluator, ConditionEvidenceInput, ConditionTaskState } from "./types";
import { addNyDays, etToUtc, nextAllowedSessionStart, nthTradingDayFrom, nyDateOf, sessionLabelAt, tradingDaysBetween } from "./nyTime";

export const REFERENCE_EVALUATOR_ID = "lane-e-reference/1";

const reason = (code: ReasonCode, evidenceIds: string[], detail?: Reason["detail"]): Reason => ({ code, severity: "block", evidenceIds, ...(detail ? { detail } : {}) });

function contextEvidenceIds(ev: ConditionEvidenceInput): string[] {
  return ev.records.filter((r) => r.payload.kind === "market_context").map((r) => r.evidenceId);
}
function eventEvidenceIds(ev: ConditionEvidenceInput, eventId: string): string[] {
  return ev.records.filter((r) => r.payload.kind === "market_event" && r.payload.eventId === eventId).map((r) => r.evidenceId);
}

function fieldProblem<T>(f: CtxField<T> | undefined, evidenceIds: string[]): Reason | null {
  if (!f) return reason("CONTEXT_UNAVAILABLE", evidenceIds);
  if (f.status === "unavailable") return reason(f.note === "not_in_tier" ? "CONTEXT_FIELD_NOT_IN_TIER" : "CONTEXT_UNAVAILABLE", evidenceIds, { source: f.source, note: f.note ?? null });
  if (f.status === "stale" || f.status === "unfinished") return reason("CONTEXT_STALE", evidenceIds, { source: f.source, observedAt: f.observedAt, fetchedAt: f.fetchedAt, status: f.status });
  if (f.value === null || f.value === undefined) return reason("CONTEXT_UNAVAILABLE", evidenceIds, { source: f.source });
  return null;
}

function evalSession(item: Extract<Condition, { type: "session" }>, now: IsoUtc, cal: MarketCalendar): ConditionItemResult {
  const label = sessionLabelAt(now, cal);
  const ok = label !== null && (item.allow as string[]).includes(label);
  if (ok) return { item, outcome: "SATISFIED", reasons: [], evidenceIds: [], nextCheckAt: null };
  return {
    item,
    outcome: "UNSATISFIED",
    reasons: [reason("SESSION_RULE_BLOCK", [], { session: label ?? "CLOSED", allow: item.allow.join(",") })],
    evidenceIds: [],
    nextCheckAt: nextAllowedSessionStart(now, item.allow, cal),
  };
}

function evalAvoidEventWindow(item: Extract<Condition, { type: "avoid_event_window" }>, ev: ConditionEvidenceInput, now: IsoUtc, cal: MarketCalendar): ConditionItemResult {
  if (!ev.context && ev.events.length === 0) {
    return { item, outcome: "INSUFFICIENT_EVIDENCE", reasons: [reason("CONTEXT_UNAVAILABLE", contextEvidenceIds(ev))], evidenceIds: contextEvidenceIds(ev), nextCheckAt: null };
  }
  const nowMs = Date.parse(now);
  const relevant = ev.events.filter((e) => item.kinds.includes(e.kind) && e.status !== "cancelled");
  const reasons: Reason[] = [];
  const ids: string[] = [];
  let outcome: ConditionOutcome = "SATISFIED";
  let nextCheckAt: IsoUtc | null = null;
  const bump = (t: IsoUtc | null) => {
    if (t && (nextCheckAt === null || t < nextCheckAt)) nextCheckAt = t;
  };
  const consider = (e: MarketEvent) => {
    const eids = eventEvidenceIds(ev, e.id);
    if (e.datePrecision === "exact" && e.scheduledAtUtc) {
      const t = Date.parse(e.scheduledAtUtc);
      const from = t - item.beforeMin * 60_000;
      const to = t + item.afterMin * 60_000;
      if (nowMs >= from && nowMs < to) {
        outcome = "UNSATISFIED";
        reasons.push(reason("EVENT_WINDOW_ACTIVE", eids, { eventId: e.id, revision: e.revision, scheduledAtUtc: e.scheduledAtUtc, windowEndsAt: new Date(to).toISOString() }));
        ids.push(...eids);
        bump(new Date(to).toISOString());
      }
      return;
    }
    // day / estimate 精度：没有确切时刻
    const dayOfNow = nyDateOf(now, cal);
    if (e.dateLocal !== dayOfNow) return;
    if (item.wholeDayIfDayPrecision) {
      outcome = "UNSATISFIED";
      reasons.push(reason("EVENT_WINDOW_ACTIVE", eids, { eventId: e.id, revision: e.revision, dateLocal: e.dateLocal, datePrecision: e.datePrecision, wholeDay: true }));
      ids.push(...eids);
      bump(etToUtc(addNyDays(e.dateLocal, 1), 0, 0));
    } else {
      if (outcome !== "UNSATISFIED") outcome = "INSUFFICIENT_EVIDENCE";
      reasons.push(reason("EVENT_DATE_UNCERTAIN", eids, { eventId: e.id, revision: e.revision, dateLocal: e.dateLocal, datePrecision: e.datePrecision }));
      ids.push(...eids);
    }
  };
  for (const e of relevant) {
    if (e.status === "estimated" && !item.includeEstimated) continue;
    consider(e);
  }
  return { item, outcome, reasons, evidenceIds: [...new Set(ids)], nextCheckAt: outcome === "SATISFIED" ? null : nextCheckAt };
}

function evalMaxVix(item: Extract<Condition, { type: "max_vix" }>, ev: ConditionEvidenceInput): ConditionItemResult {
  const ids = contextEvidenceIds(ev);
  if (!ev.context) return { item, outcome: "INSUFFICIENT_EVIDENCE", reasons: [reason("CONTEXT_UNAVAILABLE", ids)], evidenceIds: ids, nextCheckAt: null };
  const f = ev.context.risk?.vix;
  const p = fieldProblem(f, ids);
  if (p) return { item, outcome: "INSUFFICIENT_EVIDENCE", reasons: [p], evidenceIds: ids, nextCheckAt: null };
  // CV-D12：数值字段 value 是十进制字符串，比较前解析；解析不了 = 证据不足，不猜
  const v = Number(f!.value);
  if (!Number.isFinite(v)) return { item, outcome: "INSUFFICIENT_EVIDENCE", reasons: [reason("CONTEXT_UNAVAILABLE", ids, { source: f!.source, unparsableValue: String(f!.value) })], evidenceIds: ids, nextCheckAt: null };
  if (v <= item.value) return { item, outcome: "SATISFIED", reasons: [], evidenceIds: ids, nextCheckAt: null };
  return { item, outcome: "UNSATISFIED", reasons: [reason("VOL_REGIME_EXCEEDED", ids, { vix: v, max: item.value, observedAt: f!.observedAt })], evidenceIds: ids, nextCheckAt: null };
}

function evalMinGap(item: Extract<Condition, { type: "min_gap_trading_days" }>, state: ConditionTaskState, now: IsoUtc, cal: MarketCalendar): ConditionItemResult {
  if (!state.lastConfirmedStepAt) return { item, outcome: "SATISFIED", reasons: [], evidenceIds: [], nextCheckAt: null };
  const lastDay = nyDateOf(state.lastConfirmedStepAt, cal);
  const today = nyDateOf(now, cal);
  const elapsed = tradingDaysBetween(lastDay, today, cal);
  if (elapsed >= item.days) return { item, outcome: "SATISFIED", reasons: [], evidenceIds: [], nextCheckAt: null };
  const okDay = nthTradingDayFrom(addNyDays(lastDay, 1), item.days - 1, cal);
  return {
    item,
    outcome: "UNSATISFIED",
    reasons: [reason("STEP_GAP_NOT_ELAPSED", [], { lastConfirmedStepAt: state.lastConfirmedStepAt, elapsedTradingDays: elapsed, required: item.days })],
    evidenceIds: [],
    nextCheckAt: etToUtc(okDay, 9, 30),
  };
}

export function createReferenceEvaluator(cal: MarketCalendar = NYSE_CALENDAR): ConditionEvaluator {
  return {
    id: REFERENCE_EVALUATOR_ID,
    evaluate(set: ConditionSet, evidence: ConditionEvidenceInput, taskState: ConditionTaskState, now: IsoUtc): ConditionEvaluation {
      const perItem: ConditionItemResult[] = set.items.map((item) => {
        switch (item.type) {
          case "session":
            return evalSession(item, now, cal);
          case "avoid_event_window":
            return evalAvoidEventWindow(item, evidence, now, cal);
          case "max_vix":
            return evalMaxVix(item, evidence);
          case "min_gap_trading_days":
            return evalMinGap(item, taskState, now, cal);
          default:
            return {
              item,
              outcome: "INSUFFICIENT_EVIDENCE",
              reasons: [reason("CONTEXT_UNAVAILABLE", [], { unsupportedByReferenceEvaluator: true, conditionType: item.type })],
              evidenceIds: [],
              nextCheckAt: null,
            };
        }
      });
      const outcome: ConditionOutcome = perItem.some((r) => r.outcome === "UNSATISFIED") ? "UNSATISFIED" : perItem.some((r) => r.outcome === "INSUFFICIENT_EVIDENCE") ? "INSUFFICIENT_EVIDENCE" : "SATISFIED";
      const known = perItem.map((r) => r.nextCheckAt).filter((x): x is string => !!x).sort();
      return { outcome, perItem, nextCheckAt: known[0] ?? null, evaluatedAt: now, conditionsHash: set.hash };
    },
  };
}
