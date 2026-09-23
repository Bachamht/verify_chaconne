/**
 * 理由卡（C7，interfaces §11.5）纯函数：
 *  - machine 前提 = 其 Condition 的三态（SATISFIED→holds / UNSATISFIED→invalidated / INSUFFICIENT→unknown）；
 *  - research 前提只收 reviewItems（sourceUrl 必填），保持 unknown 直到用户标记；
 *  - 卡片状态：validUntil 过期 → expired；任一 machine 前提 invalidated → invalidated；任一 machine 前提 unknown → unknown；否则 holds。
 *    research 前提不参与卡片状态（它们是给用户复核的材料，不能把模型一句判断翻译成交易通过）。
 *  - onInvalidation 由服务执行：notify / pause_issuance / draft_exit（这里只判定「该不该触发」）。
 */
import type { Condition, IsoUtc, Premise, PremiseReviewItem, PremiseStatus, ThesisCard, ThesisOnInvalidation, ThesisStatus } from "../contracts";
import { makeConditionSet, evaluateConditionItem, type ConditionEvidence, type TaskConditionState } from "../conditions";
import { NYSE_CALENDAR, type MarketCalendar } from "../../calendar";
import { validateCondition } from "../conditions/validate";

export interface ThesisInput {
  goal: string;
  rationale: string;
  premises: Array<{ kind: "machine"; text: string; condition: unknown } | { kind: "research"; text: string }>;
  validUntil: IsoUtc;
  onInvalidation: ThesisOnInvalidation;
}
export interface ThesisError {
  field: string;
  code: string;
}

export const THESIS_ACTIONS: readonly ThesisOnInvalidation[] = ["notify", "pause_issuance", "draft_exit"];

export function validateThesisInput(raw: unknown, mode: "LIVE" | "SIMULATION", nowIso: IsoUtc): { ok: true; input: ThesisInput; conditions: Condition[] } | { ok: false; errors: ThesisError[] } {
  const errors: ThesisError[] = [];
  const o = (raw ?? {}) as Record<string, unknown>;
  const goal = typeof o["goal"] === "string" ? o["goal"].trim().slice(0, 200) : "";
  if (!goal) errors.push({ field: "goal", code: "required" });
  const rationale = typeof o["rationale"] === "string" ? o["rationale"].trim().slice(0, 2000) : "";
  const validUntil = typeof o["validUntil"] === "string" && !Number.isNaN(Date.parse(o["validUntil"])) ? new Date(Date.parse(o["validUntil"])).toISOString() : null;
  if (!validUntil) errors.push({ field: "validUntil", code: "expected_iso" });
  else if (Date.parse(validUntil) <= Date.parse(nowIso)) errors.push({ field: "validUntil", code: "must_be_future" });
  const onInv = o["onInvalidation"] ?? "notify";
  if (!THESIS_ACTIONS.includes(onInv as ThesisOnInvalidation)) errors.push({ field: "onInvalidation", code: "expected_notify|pause_issuance|draft_exit" });
  const premisesRaw = Array.isArray(o["premises"]) ? (o["premises"] as unknown[]) : [];
  if (premisesRaw.length > 16) errors.push({ field: "premises", code: "too_many" });
  const premises: ThesisInput["premises"] = [];
  const conditions: Condition[] = [];
  premisesRaw.forEach((p, i) => {
    const q = (p ?? {}) as Record<string, unknown>;
    const text = typeof q["text"] === "string" ? q["text"].trim().slice(0, 500) : "";
    if (!text) errors.push({ field: `premises[${i}].text`, code: "required" });
    if (q["kind"] === "machine") {
      const c = validateCondition(q["condition"], i, mode);
      if (!c.ok) errors.push(...c.errors.map((e) => ({ field: `premises[${i}].condition.${e.field}`, code: e.code })));
      else {
        premises.push({ kind: "machine", text, condition: c.item });
        conditions.push(c.item);
      }
    } else if (q["kind"] === "research") premises.push({ kind: "research", text });
    else errors.push({ field: `premises[${i}].kind`, code: "expected_machine|research" });
  });
  if (errors.length) return { ok: false, errors };
  return { ok: true, input: { goal, rationale, premises, validUntil: validUntil!, onInvalidation: onInv as ThesisOnInvalidation }, conditions };
}

export function validateReviewItem(raw: unknown, addedBy: "agent" | "user", at: IsoUtc): { ok: true; item: PremiseReviewItem } | { ok: false; errors: ThesisError[] } {
  const errors: ThesisError[] = [];
  const o = (raw ?? {}) as Record<string, unknown>;
  if (o["side"] !== "support" && o["side"] !== "counter") errors.push({ field: "side", code: "expected_support|counter" });
  const text = typeof o["text"] === "string" ? o["text"].trim().slice(0, 1000) : "";
  if (!text) errors.push({ field: "text", code: "required" });
  const url = typeof o["sourceUrl"] === "string" ? o["sourceUrl"].trim() : "";
  if (!/^https?:\/\/\S+$/.test(url)) errors.push({ field: "sourceUrl", code: "required_http_url" });
  if (errors.length) return { ok: false, errors };
  return { ok: true, item: { side: o["side"] as "support" | "counter", text, sourceUrl: url, addedBy, at } };
}

export function premiseStatusFromOutcome(outcome: "SATISFIED" | "UNSATISFIED" | "INSUFFICIENT_EVIDENCE"): PremiseStatus {
  return outcome === "SATISFIED" ? "holds" : outcome === "UNSATISFIED" ? "invalidated" : "unknown";
}

export function thesisStatusOf(premises: readonly Premise[], validUntil: IsoUtc, nowIso: IsoUtc): ThesisStatus {
  if (Date.parse(nowIso) > Date.parse(validUntil)) return "expired";
  const machine = premises.filter((p) => p.kind === "machine");
  if (machine.some((p) => p.status === "invalidated")) return "invalidated";
  if (machine.some((p) => p.status === "unknown")) return "unknown";
  return "holds";
}

export interface ThesisCheckResult {
  card: ThesisCard;
  /** 由 holds/unknown 首次变为 invalidated 的前提 id（触发 onInvalidation） */
  newlyInvalidated: string[];
  /** 本轮从非 expired 变为 expired */
  newlyExpired: boolean;
  evidenceIds: string[];
}

/** 用当前证据重评机器前提；research 前提原样保留（状态只由用户标记改变） */
export function checkThesis(card: ThesisCard, evidence: ConditionEvidence, taskState: TaskConditionState, nowIso: IsoUtc, cal: MarketCalendar = NYSE_CALENDAR): ThesisCheckResult {
  const nowMs = Date.parse(nowIso);
  const newlyInvalidated: string[] = [];
  const evidenceIds = new Set<string>();
  const premises: Premise[] = card.premises.map((p) => {
    if (p.kind !== "machine" || !p.condition) return p;
    const r = evaluateConditionItem(p.condition, { ev: evidence, st: taskState, nowMs, cal });
    const status = premiseStatusFromOutcome(r.outcome);
    for (const id of r.evidenceIds) evidenceIds.add(id);
    if (status === "invalidated" && p.status !== "invalidated") newlyInvalidated.push(p.id);
    return { ...p, status, lastCheckedAt: nowIso, evidenceIds: r.evidenceIds };
  });
  const status = thesisStatusOf(premises, card.validUntil, nowIso);
  return { card: { ...card, premises, status }, newlyInvalidated, newlyExpired: status === "expired" && card.status !== "expired", evidenceIds: [...evidenceIds].sort() };
}

/** 从条件集生成机器前提草案（每条条件一条前提；文案只描述条件，不预测） */
export function machinePremisesFromConditions(items: readonly Condition[], idPrefix: string): Premise[] {
  return items.map((c, i) => ({ id: `${idPrefix}_m${i}`, kind: "machine", text: describeCondition(c), condition: c, status: "unknown", lastCheckedAt: null, evidenceIds: [] }));
}

export function describeCondition(c: Condition): string {
  switch (c.type) {
    case "session":
      return `Session is one of ${c.allow.join(", ")}`;
    case "avoid_event_window":
      return `Not within ${c.beforeMin} min before / ${c.afterMin} min after ${c.kinds.join(", ")} events${c.includeEstimated ? " (incl. estimated)" : ""}`;
    case "earnings_window":
      return `Not within ${c.beforeTradingDays} trading day(s) before earnings; ${c.afterSessions} regular session(s) completed after`;
    case "not_in_fed_blackout":
      return "Not in a Fed communications blackout (user-selected)";
    case "max_vix":
      return `VIX ≤ ${c.value}`;
    case "max_move":
      return `MOVE ≤ ${c.value}`;
    case "premium_bps_lte":
      return `On-chain premium ≤ ${c.value} bps vs ${c.referenceKind} reference`;
    case "min_gap_trading_days":
      return `At least ${c.days} trading day(s) since the last confirmed step`;
    case "max_steps_per_trading_day":
      return `At most ${c.value} step(s) per trading day (${c.scope})`;
    case "require_cross_asset_confirmation":
      return `Cross-asset state in ${c.acceptStates.join("/")} (undecided never accepted)`;
    case "target_price_gte":
      return `Live reference price ≥ ${c.underlyingPriceUsd} USD`;
    case "target_price_lte":
      return `Live reference price ≤ ${c.underlyingPriceUsd} USD`;
    case "tracked_cost_pnl_pct_gte":
      return `Traceable-cost PnL ≥ ${c.value}%`;
    case "cash_floor":
      return `Keep ≥ ${c.floorRaw} (raw) of ${c.inputAssetKey}`;
    case "thesis_holds":
      return `Thesis ${c.thesisId} holds`;
  }
}

/** thesis_holds 条件用的最小集合（保证同哈希规则） */
export function thesisHoldsCondition(thesisId: string): Condition {
  return { type: "thesis_holds", thesisId };
}
export { makeConditionSet as buildThesisConditionSet };
