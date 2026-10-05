/**
 * v7 · 事件实际值（P0-D，interfaces §12.7，CV-D22）纯函数：
 *  - validateEventOutcome：结构 + 十进制字符串校验（canon-1 不允许浮点；D-05）
 *  - outcomeHash：规范化哈希（服务端据此派生 outcomeRevision）
 *  - eventDataStatus / eventObservationKey：upcoming / due_pending_data / data_arrived / revised
 *  - compareToExpectation / unsupportedSurpriseTerms：没有预期值就不给「超预期 / 不及预期」（D-04）
 *
 * outcomeRevision 不由 producer 给：首次附上 = 0，之后 outcomeHash 每变一次 +1（服务端派生）。
 */
import { hashCanonical } from "../canonical";
import type { Bytes32, EventDataStatus, EventOutcome, EventOutcomeMetric, MarketEvent } from "../contracts";
import { zonedDayBoundsUtcMs } from "../conditions/calendarUtil";

export interface OutcomeSchemaError {
  path: string;
  code: string;
}
export type OutcomeSchemaResult = { ok: true; outcome: EventOutcome } | { ok: false; errors: OutcomeSchemaError[] };

/** 十进制字符串：可带负号；不允许指数、前导 +、空小数位 */
export const DECIMAL_STRING_RE = /^-?\d+(\.\d+)?$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;
export const OUTCOME_METRICS_MIN = 1;
export const OUTCOME_METRICS_MAX = 12;
const EXPECTATION_KINDS: ReadonlySet<string> = new Set(["survey", "market_implied"]);
const PROVIDERS: ReadonlySet<string> = new Set(["crowsnest", "finnhub"]);

const nonEmptyString = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0;

/** 十进制校验：number（浮点或整数）一律拒——生产方必须给字符串 */
function checkDecimal(v: unknown, path: string, errors: OutcomeSchemaError[]): void {
  if (typeof v === "number") errors.push({ path, code: "number_not_allowed_use_decimal_string" });
  else if (typeof v !== "string" || !DECIMAL_STRING_RE.test(v)) errors.push({ path, code: "expected_decimal_string" });
}

export function validateEventOutcome(raw: unknown, basePath = "outcome"): OutcomeSchemaResult {
  const errors: OutcomeSchemaError[] = [];
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, errors: [{ path: basePath, code: "not_object" }] };
  const o = raw as Record<string, unknown>;
  const metricsRaw = o["metrics"];
  if (!Array.isArray(metricsRaw)) errors.push({ path: `${basePath}.metrics`, code: "expected_array" });
  else if (metricsRaw.length < OUTCOME_METRICS_MIN || metricsRaw.length > OUTCOME_METRICS_MAX) errors.push({ path: `${basePath}.metrics`, code: "expected_1_to_12_metrics" });
  if (!nonEmptyString(o["source"])) errors.push({ path: `${basePath}.source`, code: "expected_string" });
  if (o["sourceUrl"] !== undefined && !nonEmptyString(o["sourceUrl"])) errors.push({ path: `${basePath}.sourceUrl`, code: "expected_string" });
  if (!ISO_RE.test(String(o["publishedAt"]))) errors.push({ path: `${basePath}.publishedAt`, code: "expected_iso" });
  if (!ISO_RE.test(String(o["fetchedAt"]))) errors.push({ path: `${basePath}.fetchedAt`, code: "expected_iso" });
  if (!PROVIDERS.has(String(o["provider"]))) errors.push({ path: `${basePath}.provider`, code: "unknown_provider" });

  const metrics: EventOutcomeMetric[] = [];
  if (Array.isArray(metricsRaw)) {
    const seen = new Set<string>();
    metricsRaw.forEach((m, i) => {
      const p = `${basePath}.metrics[${i}]`;
      if (typeof m !== "object" || m === null || Array.isArray(m)) {
        errors.push({ path: p, code: "not_object" });
        return;
      }
      const r = m as Record<string, unknown>;
      const before = errors.length;
      if (!nonEmptyString(r["key"])) errors.push({ path: `${p}.key`, code: "expected_string" });
      else if (seen.has(r["key"])) errors.push({ path: `${p}.key`, code: "duplicate_key" });
      else seen.add(r["key"]);
      if (!nonEmptyString(r["label"])) errors.push({ path: `${p}.label`, code: "expected_string" });
      checkDecimal(r["actual"], `${p}.actual`, errors);
      if (!nonEmptyString(r["unit"])) errors.push({ path: `${p}.unit`, code: "required" });
      if (!nonEmptyString(r["period"])) errors.push({ path: `${p}.period`, code: "required" });
      if (r["previous"] !== undefined) checkDecimal(r["previous"], `${p}.previous`, errors);
      if (r["revisedPrevious"] !== undefined) checkDecimal(r["revisedPrevious"], `${p}.revisedPrevious`, errors);
      let expectation: EventOutcomeMetric["expectation"];
      if (r["expectation"] !== undefined) {
        const e = r["expectation"] as Record<string, unknown> | null;
        if (typeof e !== "object" || e === null || Array.isArray(e)) errors.push({ path: `${p}.expectation`, code: "not_object" });
        else {
          checkDecimal(e["value"], `${p}.expectation.value`, errors);
          if (!EXPECTATION_KINDS.has(String(e["kind"]))) errors.push({ path: `${p}.expectation.kind`, code: "expected_survey_or_market_implied" });
          if (!nonEmptyString(e["source"])) errors.push({ path: `${p}.expectation.source`, code: "expected_string" });
          if (!ISO_RE.test(String(e["at"]))) errors.push({ path: `${p}.expectation.at`, code: "expected_iso" });
          expectation = { value: e["value"] as string, kind: e["kind"] as "survey" | "market_implied", source: e["source"] as string, at: e["at"] as string };
        }
      }
      if (errors.length > before) return;
      // 只保留契约键（未知键剥离）
      metrics.push({
        key: r["key"] as string,
        label: r["label"] as string,
        actual: r["actual"] as string,
        unit: r["unit"] as string,
        period: r["period"] as string,
        ...(r["previous"] !== undefined ? { previous: r["previous"] as string } : {}),
        ...(r["revisedPrevious"] !== undefined ? { revisedPrevious: r["revisedPrevious"] as string } : {}),
        ...(expectation ? { expectation } : {}),
      });
    });
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    outcome: {
      metrics,
      source: o["source"] as string,
      ...(o["sourceUrl"] !== undefined ? { sourceUrl: o["sourceUrl"] as string } : {}),
      publishedAt: o["publishedAt"] as string,
      fetchedAt: o["fetchedAt"] as string,
      provider: o["provider"] as EventOutcome["provider"],
    },
  };
}

/**
 * outcome 规范化哈希：只覆盖「数据内容」——metrics（按 key 排序）、source、sourceUrl、provider。
 * 不含 fetchedAt / publishedAt / expectation.at：重复抓取同一份数据（时间戳变）不是修订；
 * Finnhub 不给发布时刻与预估时刻（取观测时刻，见 earnings/mapping.ts），也不能让它们制造修订。
 */
export function outcomeHash(o: EventOutcome): Bytes32 {
  const metrics = [...o.metrics]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((m) => ({ ...m, expectation: m.expectation ? { value: m.expectation.value, kind: m.expectation.kind, source: m.expectation.source } : undefined }));
  return hashCanonical({ v: "event-outcome/1", metrics, source: o.source, sourceUrl: o.sourceUrl, provider: o.provider });
}

/** 服务端派生：给定上一份（哈希, outcomeRevision）与新 outcome → 变化类型与新修订号 */
export type OutcomeChange = { kind: "none" } | { kind: "data_arrived"; hash: Bytes32; outcomeRevision: 0 } | { kind: "revised"; hash: Bytes32; outcomeRevision: number } | { kind: "unchanged"; hash: Bytes32; outcomeRevision: number };
export function deriveOutcomeChange(prev: { hash: string | null; outcomeRevision: number } | null, next: EventOutcome | undefined): OutcomeChange {
  if (!next) return { kind: "none" };
  const hash = outcomeHash(next);
  if (!prev || !prev.hash) return { kind: "data_arrived", hash, outcomeRevision: 0 };
  if (prev.hash === hash) return { kind: "unchanged", hash, outcomeRevision: prev.outcomeRevision };
  return { kind: "revised", hash, outcomeRevision: prev.outcomeRevision + 1 };
}

/**
 * 预定时刻（ms）：exact → scheduledAtUtc；日精度 / 估计 → 当地日结束（整天都可能发布，日内不算「到点」）。
 */
export function eventDueAtMs(ev: Pick<MarketEvent, "scheduledAtUtc" | "dateLocal" | "tz">): number {
  if (ev.scheduledAtUtc) return Date.parse(ev.scheduledAtUtc);
  return zonedDayBoundsUtcMs(ev.tz, ev.dateLocal).endMs;
}

/**
 * §12.7：预定时刻未到 → upcoming；已过且无 outcome → due_pending_data；
 * 有 outcome 且 outcomeRevision = 0（或未给）→ data_arrived；≥ 1 → revised。
 * 有 outcome 时不看时间（数据先于日程是 producer 的事，按数据算）。
 * cancelled 且无 outcome：永不「到点」（不开去核实轮次）→ upcoming。
 */
export function eventDataStatus(ev: MarketEvent & { outcome?: EventOutcome; outcomeRevision?: number }, nowMs: number): EventDataStatus {
  if (ev.outcome) return (ev.outcomeRevision ?? 0) >= 1 ? "revised" : "data_arrived";
  if (ev.status === "cancelled") return "upcoming";
  return eventDueAtMs(ev) <= nowMs ? "due_pending_data" : "upcoming";
}

/** 任务的事件观察键（替代旧的 `${id}@${revision}:${upcoming|released}`） */
export function eventObservationKey(ev: MarketEvent & { outcome?: EventOutcome; outcomeRevision?: number }, nowMs: number): string {
  return `${ev.id}@${ev.revision}:${eventDataStatus(ev, nowMs)}`;
}

/* ---------------- 十进制比较（不经浮点） ---------------- */

function splitDecimal(s: string): { neg: boolean; int: string; frac: string } {
  const neg = s.startsWith("-");
  const body = neg ? s.slice(1) : s;
  const [i = "0", f = ""] = body.split(".");
  return { neg, int: i.replace(/^0+(?=\d)/, ""), frac: f.replace(/0+$/, "") };
}
function cmpAbs(a: { int: string; frac: string }, b: { int: string; frac: string }): number {
  if (a.int.length !== b.int.length) return a.int.length < b.int.length ? -1 : 1;
  if (a.int !== b.int) return a.int < b.int ? -1 : 1;
  const n = Math.max(a.frac.length, b.frac.length);
  const fa = a.frac.padEnd(n, "0");
  const fb = b.frac.padEnd(n, "0");
  return fa === fb ? 0 : fa < fb ? -1 : 1;
}
/** 比较两个十进制字符串：-1 / 0 / 1；非法输入抛错 */
export function compareDecimalStrings(a: string, b: string): -1 | 0 | 1 {
  if (!DECIMAL_STRING_RE.test(a) || !DECIMAL_STRING_RE.test(b)) throw new Error("compareDecimalStrings: expected decimal strings");
  const x = splitDecimal(a);
  const y = splitDecimal(b);
  const zx = x.int === "0" && x.frac === "";
  const zy = y.int === "0" && y.frac === "";
  const nx = x.neg && !zx;
  const ny = y.neg && !zy;
  if (nx !== ny) return nx ? -1 : 1;
  const c = cmpAbs(x, y);
  return (nx ? -c : c) as -1 | 0 | 1;
}

/* ---------------- D-04：没有预期值就不说「超 / 不及预期」 ---------------- */

/**
 * 实际值相对预期值的方向。没有 expectation → `no_expectation`（调用方**不得**生成「超预期 / 不及预期」）。
 * 只给方向（above / below / equal），不判好坏：失业率高于预期对市场是「不及」，这一层不替指标定方向。
 */
export type ExpectationComparison = { kind: "no_expectation"; key: string } | { kind: "compared"; key: string; direction: "above" | "below" | "equal"; expectationKind: "survey" | "market_implied"; expectationSource: string };
export function compareToExpectation(m: EventOutcomeMetric): ExpectationComparison {
  if (!m.expectation) return { kind: "no_expectation", key: m.key };
  const c = compareDecimalStrings(m.actual, m.expectation.value);
  return { kind: "compared", key: m.key, direction: c > 0 ? "above" : c < 0 ? "below" : "equal", expectationKind: m.expectation.kind, expectationSource: m.expectation.source };
}

/** 展示用标签：有预期值才给；没有 → null（拒绝贴「beat / miss」） */
export function expectationLabel(m: EventOutcomeMetric): "above_expectation" | "below_expectation" | "in_line" | null {
  const c = compareToExpectation(m);
  if (c.kind === "no_expectation") return null;
  return c.direction === "above" ? "above_expectation" : c.direction === "below" ? "below_expectation" : "in_line";
}

const SURPRISE_TERMS: readonly RegExp[] = [/\bbeats?\b/i, /\bmiss(?:es|ed)?\b/i, /\b(?:above|below|ahead of|short of|in line with|exceed(?:s|ed)?|top(?:s|ped)?)\s+(?:the\s+)?(?:consensus|expectations?|estimates?|forecasts?)\b/i, /\bsurprise\b/i, /超预期/, /不及预期/, /低于预期/, /高于预期/, /符合预期/, /好于预期/, /差于预期/];

/**
 * 文本守卫（页面 / Agent 输出复用）：若 outcome 里**对应指标**没有预期值，返回文本里出现的「超 / 不及预期」类措辞；
 * 空数组 = 合规。outcome 缺失视为全部无预期。只要有任一指标带预期值，就不拦（措辞对应哪个指标由调用方负责）。
 */
export function unsupportedSurpriseTerms(text: string, outcome: EventOutcome | null | undefined): string[] {
  const anyExpectation = !!outcome && outcome.metrics.some((m) => m.expectation !== undefined);
  if (anyExpectation) return [];
  const hits: string[] = [];
  for (const re of SURPRISE_TERMS) {
    const m = re.exec(text);
    if (m) hits.push(m[0]);
  }
  return hits;
}
