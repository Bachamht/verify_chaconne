/**
 * 财报后闸门（E-06）：财报窗口计时结束 ≠ 可以买。还要看（1）股票参考价是否恢复为实时；（2）链上报价冲击是否在上限内。
 * 两个都不满足时**两个原因都列出**，文案来自原因码映射（不写涨跌、不预测）。
 * 纯函数；quote / reference 的取证由调用方（prepare-step 前置链，Lane B）提供。
 */
import { NYSE_CALENDAR, type MarketCalendar, type Session } from "@chaconne/core";
import type { Blocker, ConditionOutcome, IsoUtc, MarketEvent, ReasonCode } from "@chaconne/core/verify";
import { earningsWindow, type EarningsWindowCondition } from "../events/earnings/window";
import { reasonText } from "./reasonText";

export interface PostEarningsInputs {
  event: MarketEvent;
  condition: EarningsWindowCondition;
  nowIso: IsoUtc;
  session: Session;
  reference: { status: "live" | "close" | "stale" | "missing"; observedAt: IsoUtc | null; evidenceId?: string };
  quote: { status: "ok" | "unavailable"; priceImpactBps: number | null; evidenceId?: string };
  maxPriceImpactBps: number;
  calendar?: MarketCalendar;
}
export interface PostEarningsGate {
  outcome: ConditionOutcome;
  windowEnded: boolean;
  windowEndUtc: IsoUtc;
  blockers: Blocker[];
  nextCheckAt: IsoUtc | null;
}

const mk = (code: ReasonCode, evidenceIds: string[], evidenceAt: IsoUtc | null, nextCheckAt: IsoUtc | null): Blocker => ({ code, evidenceIds, evidenceAt, nextCheckAt, userActionRequired: false, text: reasonText(code, "zh") });

export function postEarningsGate(i: PostEarningsInputs): PostEarningsGate {
  const w = earningsWindow(i.event, i.condition, i.calendar ?? NYSE_CALENDAR);
  const now = Date.parse(i.nowIso);
  const ended = now >= Date.parse(w.endUtc);
  if (!ended) {
    return { outcome: "UNSATISFIED", windowEnded: false, windowEndUtc: w.endUtc, blockers: [mk("EARNINGS_WINDOW_ACTIVE", [], i.event.sourceFetchedAt, w.endUtc)], nextCheckAt: w.endUtc };
  }
  const blockers: Blocker[] = [];
  let insufficient = false;
  if (i.condition.requireRegularSessionAfter && i.session !== "REGULAR") blockers.push(mk("MARKET_OUTSIDE_REGULAR", [], null, null));
  if (i.condition.requireLiveReferenceAfter && i.reference.status !== "live") {
    const code: ReasonCode = i.reference.status === "missing" ? "REFERENCE_MISSING" : "REFERENCE_STALE";
    if (code === "REFERENCE_MISSING") insufficient = true;
    blockers.push(mk(code, i.reference.evidenceId ? [i.reference.evidenceId] : [], i.reference.observedAt, null));
  }
  if (i.quote.status === "unavailable") {
    insufficient = true;
    blockers.push(mk("QUOTE_UNAVAILABLE", [], null, null));
  } else if (i.quote.priceImpactBps === null) {
    insufficient = true;
    blockers.push(mk("PRICE_IMPACT_UNKNOWN", i.quote.evidenceId ? [i.quote.evidenceId] : [], null, null));
  } else if (i.quote.priceImpactBps > i.maxPriceImpactBps) {
    blockers.push(mk("PRICE_IMPACT_EXCEEDED", i.quote.evidenceId ? [i.quote.evidenceId] : [], null, null));
  }
  const outcome: ConditionOutcome = blockers.length === 0 ? "SATISFIED" : insufficient ? "INSUFFICIENT_EVIDENCE" : "UNSATISFIED";
  return { outcome, windowEnded: true, windowEndUtc: w.endUtc, blockers, nextCheckAt: null };
}
