/**
 * 条件 DSL 结构校验（interfaces §11.4）。
 *  - `premium_bps_lte` 的 official_close / close_last_tick 口径只允许 SIMULATION/观察：LIVE 任务一律拒绝（Y-05）；
 *  - `require_cross_asset_confirmation.acceptStates` 不接受 undecided、不接受空集（K-08）；
 *  - `not_in_fed_blackout` 允许用户显式加入，但模板默认不含（K-07）——这里只校验结构。
 */
import { EVENT_KINDS, type Condition, type ConditionSet, type ConditionType, type EventKind } from "../contracts";
import { isDecimalString, isRawAmount } from "../amounts";
import { makeConditionSet, CONDITIONS_VERSION } from "./hash";

export interface ConditionError {
  index: number;
  field: string;
  code: string;
}
export type ConditionSetResult = { ok: true; set: ConditionSet } | { ok: false; errors: ConditionError[] };

export const CONDITION_TYPES: readonly ConditionType[] = ["session", "avoid_event_window", "earnings_window", "not_in_fed_blackout", "max_vix", "max_move", "premium_bps_lte", "min_gap_trading_days", "max_steps_per_trading_day", "require_cross_asset_confirmation", "target_price_gte", "target_price_lte", "tracked_cost_pnl_pct_gte", "cash_floor", "thesis_holds"];

const SESSIONS = new Set(["US_REGULAR", "US_PRE", "US_POST"]);
const KINDS = new Set<string>(EVENT_KINDS);
const REF_KINDS = new Set(["live", "official_close", "close_last_tick"]);
const CROSS = new Set(["relief", "transmission", "divergence"]);

const isInt = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;
const isNum = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;

export function validateCondition(raw: unknown, index: number, mode: "LIVE" | "SIMULATION"): { ok: true; item: Condition } | { ok: false; errors: ConditionError[] } {
  const errors: ConditionError[] = [];
  const err = (field: string, code: string) => errors.push({ index, field, code });
  if (typeof raw !== "object" || raw === null) return { ok: false, errors: [{ index, field: "$", code: "not_object" }] };
  const o = raw as Record<string, unknown>;
  const type = o["type"];
  if (!CONDITION_TYPES.includes(type as ConditionType)) return { ok: false, errors: [{ index, field: "type", code: "unknown_type" }] };
  let item: Condition | null = null;
  switch (type as ConditionType) {
    case "session": {
      const allow = o["allow"];
      if (!Array.isArray(allow) || allow.length === 0 || allow.some((s) => !SESSIONS.has(String(s)))) err("allow", "expected_nonempty_session_list");
      else item = { type: "session", allow: [...new Set(allow as Array<"US_REGULAR" | "US_PRE" | "US_POST">)] };
      break;
    }
    case "avoid_event_window": {
      const kinds = o["kinds"];
      if (!Array.isArray(kinds) || kinds.length === 0 || kinds.some((k) => !KINDS.has(String(k)))) err("kinds", "expected_nonempty_event_kinds");
      if (!isInt(o["beforeMin"], 0, 7 * 1440)) err("beforeMin", "expected_int_0_10080");
      if (!isInt(o["afterMin"], 0, 7 * 1440)) err("afterMin", "expected_int_0_10080");
      if (typeof o["includeEstimated"] !== "boolean") err("includeEstimated", "expected_boolean");
      if (typeof o["wholeDayIfDayPrecision"] !== "boolean") err("wholeDayIfDayPrecision", "expected_boolean");
      if (errors.length === 0) item = { type: "avoid_event_window", kinds: [...new Set(kinds as EventKind[])], beforeMin: o["beforeMin"] as number, afterMin: o["afterMin"] as number, includeEstimated: o["includeEstimated"] as boolean, wholeDayIfDayPrecision: o["wholeDayIfDayPrecision"] as boolean };
      break;
    }
    case "earnings_window": {
      if (!isInt(o["beforeTradingDays"], 0, 30)) err("beforeTradingDays", "expected_int_0_30");
      if (!isInt(o["afterSessions"], 0, 30)) err("afterSessions", "expected_int_0_30");
      if (typeof o["requireRegularSessionAfter"] !== "boolean") err("requireRegularSessionAfter", "expected_boolean");
      if (typeof o["requireLiveReferenceAfter"] !== "boolean") err("requireLiveReferenceAfter", "expected_boolean");
      if (errors.length === 0) item = { type: "earnings_window", beforeTradingDays: o["beforeTradingDays"] as number, afterSessions: o["afterSessions"] as number, requireRegularSessionAfter: o["requireRegularSessionAfter"] as boolean, requireLiveReferenceAfter: o["requireLiveReferenceAfter"] as boolean };
      break;
    }
    case "not_in_fed_blackout":
      item = { type: "not_in_fed_blackout" };
      break;
    case "max_vix":
      if (!isNum(o["value"], 0, 200)) err("value", "expected_number_0_200");
      else item = { type: "max_vix", value: o["value"] as number };
      break;
    case "max_move":
      if (!isNum(o["value"], 0, 500)) err("value", "expected_number_0_500");
      else item = { type: "max_move", value: o["value"] as number };
      break;
    case "premium_bps_lte": {
      if (!isInt(o["value"], -10_000, 10_000)) err("value", "expected_int_bps");
      const rk = o["referenceKind"];
      if (!REF_KINDS.has(String(rk))) err("referenceKind", "expected_live|official_close|close_last_tick");
      else if (mode === "LIVE" && rk !== "live") err("referenceKind", "close_reference_not_allowed_for_live_execution");
      if (o["liveOnlyForExecution"] !== true) err("liveOnlyForExecution", "must_be_true");
      if (errors.length === 0) item = { type: "premium_bps_lte", value: o["value"] as number, referenceKind: rk as "live" | "official_close" | "close_last_tick", liveOnlyForExecution: true };
      break;
    }
    case "min_gap_trading_days":
      if (!isInt(o["days"], 0, 60)) err("days", "expected_int_0_60");
      else item = { type: "min_gap_trading_days", days: o["days"] as number };
      break;
    case "max_steps_per_trading_day":
      if (!isInt(o["value"], 1, 100)) err("value", "expected_int_1_100");
      if (o["scope"] !== "task" && o["scope"] !== "budget_group") err("scope", "expected_task|budget_group");
      if (errors.length === 0) item = { type: "max_steps_per_trading_day", value: o["value"] as number, scope: o["scope"] as "task" | "budget_group" };
      break;
    case "require_cross_asset_confirmation": {
      const states = o["acceptStates"];
      if (!Array.isArray(states) || states.length === 0) err("acceptStates", "expected_nonempty_list");
      else if (states.some((s) => s === "undecided")) err("acceptStates", "undecided_not_accepted");
      else if (states.some((s) => !CROSS.has(String(s)))) err("acceptStates", "unknown_state");
      if (errors.length === 0) item = { type: "require_cross_asset_confirmation", acceptStates: [...new Set(states as Array<"relief" | "transmission" | "divergence">)] };
      break;
    }
    case "target_price_gte":
    case "target_price_lte": {
      if (!isDecimalString(o["underlyingPriceUsd"]) || Number(o["underlyingPriceUsd"]) <= 0) err("underlyingPriceUsd", "expected_positive_decimal_string");
      if (o["referenceKind"] !== "live") err("referenceKind", "must_be_live");
      if (errors.length === 0) item = { type: type as "target_price_gte" | "target_price_lte", underlyingPriceUsd: o["underlyingPriceUsd"] as string, referenceKind: "live" };
      break;
    }
    case "tracked_cost_pnl_pct_gte":
      if (!isNum(o["value"], -100, 10_000)) err("value", "expected_number_pct");
      else item = { type: "tracked_cost_pnl_pct_gte", value: o["value"] as number };
      break;
    case "cash_floor":
      if (typeof o["inputAssetKey"] !== "string" || !/^eip155:\d+:0x[0-9a-f]{40}$/.test(o["inputAssetKey"])) err("inputAssetKey", "expected_asset_key");
      if (!isRawAmount(o["floorRaw"])) err("floorRaw", "expected_raw_amount");
      if (errors.length === 0) item = { type: "cash_floor", inputAssetKey: o["inputAssetKey"] as string, floorRaw: o["floorRaw"] as string };
      break;
    case "thesis_holds":
      if (typeof o["thesisId"] !== "string" || !o["thesisId"]) err("thesisId", "expected_string");
      else item = { type: "thesis_holds", thesisId: o["thesisId"] as string };
      break;
  }
  if (errors.length > 0 || !item) return { ok: false, errors: errors.length ? errors : [{ index, field: "$", code: "invalid" }] };
  return { ok: true, item };
}

/** 校验整个集合（重复类型只允许 avoid_event_window / thesis_holds / cash_floor / target_* 各多条；其余类型唯一） */
export function validateConditionSet(raw: unknown, mode: "LIVE" | "SIMULATION"): ConditionSetResult {
  const errors: ConditionError[] = [];
  const o = (raw ?? {}) as Record<string, unknown>;
  if (o["version"] !== undefined && o["version"] !== CONDITIONS_VERSION) errors.push({ index: -1, field: "version", code: "unsupported_version" });
  const items = o["items"];
  if (!Array.isArray(items)) return { ok: false, errors: [...errors, { index: -1, field: "items", code: "expected_array" }] };
  if (items.length > 32) errors.push({ index: -1, field: "items", code: "too_many_items" });
  const out: Condition[] = [];
  const seen = new Map<string, number>();
  const REPEATABLE = new Set<ConditionType>(["avoid_event_window", "thesis_holds", "cash_floor", "target_price_gte", "target_price_lte"]);
  items.forEach((it, i) => {
    const r = validateCondition(it, i, mode);
    if (!r.ok) {
      errors.push(...r.errors);
      return;
    }
    const n = (seen.get(r.item.type) ?? 0) + 1;
    seen.set(r.item.type, n);
    if (n > 1 && !REPEATABLE.has(r.item.type)) errors.push({ index: i, field: "type", code: "duplicate_type" });
    out.push(r.item);
  });
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, set: makeConditionSet(out) };
}
