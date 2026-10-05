/** v7 Lane D · D1 事件实际值纯函数：outcome 校验（D-05）、数据状态（D-01 纯函数部分）、观察键、预期值守卫（D-04） */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { EventOutcome, EventOutcomeMetric, MarketEvent } from "../src/verify/contracts";
import { compareDecimalStrings, compareToExpectation, deriveOutcomeChange, eventDataStatus, eventDueAtMs, eventObservationKey, expectationLabel, outcomeHash, unsupportedSurpriseTerms, validateEventOutcome, validateMarketEvent } from "../src/verify/events";

const FIX = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "src", "verify", "__fixtures__", "v7", "nfp-2026-10-02", "FIXTURE_nfp_outcome_event.json"), "utf8")) as { mode: string; scheduled: Record<string, unknown>; arrived: Record<string, unknown>; corrected: Record<string, unknown> };
const arrivedOutcome = () => structuredClone(FIX.arrived["outcome"]) as Record<string, unknown> & { metrics: Array<Record<string, unknown>> };
const T_DUE = Date.parse("2026-10-02T12:30:00.000Z");

describe("D4 fixture 自检", () => {
  it("FIXTURE 标记在文件头；三个快照都通过 validateMarketEvent；没有 expectation", () => {
    expect(FIX.mode).toBe("FIXTURE");
    expect(String((FIX as unknown as Record<string, unknown>)["$comment"])).toMatch(/^FIXTURE/);
    for (const k of ["scheduled", "arrived", "corrected"] as const) expect(validateMarketEvent(FIX[k]).ok).toBe(true);
    const r = validateMarketEvent(FIX.arrived);
    expect(r.ok && r.event.outcome?.metrics.map((m) => m.key)).toEqual(["payrolls_change", "unemployment_rate", "ahe_mom"]);
    expect(r.ok && r.event.outcome?.metrics.every((m) => m.expectation === undefined)).toBe(true);
  });
});

describe("D-05 outcome 校验：十进制字符串、单位、统计期；浮点被拒", () => {
  it("合法 outcome 通过；未知键剥离；producer 给的 outcomeRevision / dataStatus 被剥离", () => {
    const raw = { ...FIX.arrived, outcomeRevision: 7, dataStatus: "revised", outcome: { ...arrivedOutcome(), junk: 1 } };
    const r = validateMarketEvent(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event).not.toHaveProperty("outcomeRevision");
    expect(r.event).not.toHaveProperty("dataStatus");
    expect(r.event.outcome).not.toHaveProperty("junk");
  });
  it("actual 为 number（浮点 / 整数）→ 拒；指数 / 前导 + / 空小数 → 拒；负数与小数 → 过", () => {
    for (const bad of [4.4, 111, "4.4e1", "+4.4", "4.", ".4", "", "4,4", "NaN"]) {
      const o = arrivedOutcome();
      o.metrics[0]!["actual"] = bad;
      const r = validateEventOutcome(o);
      expect(r.ok, `actual=${String(bad)}`).toBe(false);
      if (!r.ok) expect(r.errors[0]).toMatchObject({ path: "outcome.metrics[0].actual" });
    }
    const numErr = validateEventOutcome({ ...arrivedOutcome(), metrics: [{ ...arrivedOutcome().metrics[0], actual: 4.4 }] });
    expect(!numErr.ok && numErr.errors[0]!.code).toBe("number_not_allowed_use_decimal_string");
    for (const good of ["-12", "0", "0.25", "-0.1", "250000"]) {
      const o = arrivedOutcome();
      o.metrics[0]!["actual"] = good;
      expect(validateEventOutcome(o).ok, good).toBe(true);
    }
  });
  it("previous / revisedPrevious / expectation.value 同样的十进制规则；expectation.kind ∈ survey|market_implied", () => {
    for (const field of ["previous", "revisedPrevious"]) {
      const o = arrivedOutcome();
      o.metrics[0]![field] = 22.5;
      expect(validateEventOutcome(o).ok, field).toBe(false);
    }
    const withExp = (e: unknown) => {
      const o = arrivedOutcome();
      o.metrics[0]!["expectation"] = e;
      return validateEventOutcome(o);
    };
    expect(withExp({ value: "100", kind: "survey", source: "fixture.survey", at: "2026-10-01T00:00:00.000Z" }).ok).toBe(true);
    expect(withExp({ value: "100", kind: "market_implied", source: "fixture.mkt", at: "2026-10-01T00:00:00.000Z" }).ok).toBe(true);
    expect(withExp({ value: 100, kind: "survey", source: "s", at: "2026-10-01T00:00:00.000Z" }).ok).toBe(false);
    expect(withExp({ value: "100", kind: "guess", source: "s", at: "2026-10-01T00:00:00.000Z" }).ok).toBe(false);
    expect(withExp({ value: "100", kind: "survey", source: "", at: "2026-10-01T00:00:00.000Z" }).ok).toBe(false);
    expect(withExp({ value: "100", kind: "survey", source: "s", at: "yesterday" }).ok).toBe(false);
  });
  it("unit / period 必填；metrics 1..12；key 不重复；provider 只收 crowsnest|finnhub", () => {
    for (const f of ["unit", "period", "label", "key"]) {
      const o = arrivedOutcome();
      delete o.metrics[0]![f];
      expect(validateEventOutcome(o).ok, f).toBe(false);
    }
    expect(validateEventOutcome({ ...arrivedOutcome(), metrics: [] }).ok).toBe(false);
    const m = arrivedOutcome().metrics[1]!;
    const twelve = Array.from({ length: 12 }, (_, i) => ({ ...m, key: `k${i}` }));
    expect(validateEventOutcome({ ...arrivedOutcome(), metrics: twelve }).ok).toBe(true);
    expect(validateEventOutcome({ ...arrivedOutcome(), metrics: [...twelve, { ...m, key: "k12" }] }).ok).toBe(false);
    expect(validateEventOutcome({ ...arrivedOutcome(), metrics: [m, m] }).ok).toBe(false);
    expect(validateEventOutcome({ ...arrivedOutcome(), provider: "agent" }).ok).toBe(false);
    expect(validateEventOutcome({ ...arrivedOutcome(), publishedAt: "soon" }).ok).toBe(false);
  });
  it("坏 outcome 让整个事件校验失败（错误路径带 outcome. 前缀）", () => {
    const o = arrivedOutcome();
    o.metrics[2]!["actual"] = 0.1;
    const r = validateMarketEvent({ ...FIX.arrived, outcome: o });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.map((e) => e.path)).toEqual(["outcome.metrics[2].actual"]);
  });
});

describe("D-01 / §12.7 eventDataStatus 四种状态 + 观察键", () => {
  const scheduled = () => (validateMarketEvent(FIX.scheduled) as { ok: true; event: MarketEvent }).event;
  const arrived = () => (validateMarketEvent(FIX.arrived) as { ok: true; event: MarketEvent & { outcome?: EventOutcome } }).event;
  it("未到点 → upcoming；到点无 outcome → due_pending_data（status=released 但无 outcome 也算 pending）", () => {
    expect(eventDataStatus(scheduled(), T_DUE - 1)).toBe("upcoming");
    expect(eventDataStatus(scheduled(), T_DUE)).toBe("due_pending_data");
    expect(eventDataStatus({ ...scheduled(), status: "released" }, T_DUE + 60_000)).toBe("due_pending_data");
  });
  it("有 outcome：outcomeRevision 0 / 缺省 → data_arrived；≥1 → revised（不看时间）", () => {
    expect(eventDataStatus(arrived(), T_DUE + 40_000)).toBe("data_arrived");
    expect(eventDataStatus({ ...arrived(), outcomeRevision: 0 }, T_DUE)).toBe("data_arrived");
    expect(eventDataStatus({ ...arrived(), outcomeRevision: 1 }, T_DUE)).toBe("revised");
    expect(eventDataStatus({ ...arrived(), outcomeRevision: 3 }, 0)).toBe("revised");
  });
  it("日精度：当地日结束才算到点；cancelled 无 outcome 永不到点", () => {
    const day = { ...scheduled(), datePrecision: "day" as const, scheduledAtUtc: null };
    const endNy = Date.parse("2026-10-03T04:00:00.000Z"); // 2026-10-02 24:00 EDT
    expect(eventDueAtMs(day)).toBe(endNy);
    expect(eventDataStatus(day, endNy - 1)).toBe("upcoming");
    expect(eventDataStatus(day, endNy)).toBe("due_pending_data");
    expect(eventDataStatus({ ...scheduled(), status: "cancelled" }, T_DUE + 86_400_000)).toBe("upcoming");
  });
  it("观察键 = `${id}@${revision}:${dataStatus}`；三个阶段键各不相同", () => {
    const id = "fixture.crowsnest:MACRO_TIER1:2026-10-02:nfp";
    expect(eventObservationKey(scheduled(), T_DUE - 1)).toBe(`${id}@3:upcoming`);
    expect(eventObservationKey(scheduled(), T_DUE + 1)).toBe(`${id}@3:due_pending_data`);
    expect(eventObservationKey({ ...arrived(), outcomeRevision: 0 }, T_DUE + 1)).toBe(`${id}@4:data_arrived`);
    expect(eventObservationKey({ ...arrived(), revision: 5, outcomeRevision: 1 }, T_DUE + 1)).toBe(`${id}@5:revised`);
  });
});

describe("outcome 规范化哈希与 outcomeRevision 派生", () => {
  const o = () => (validateEventOutcome(arrivedOutcome()) as { ok: true; outcome: EventOutcome }).outcome;
  it("fetchedAt / publishedAt / metrics 顺序不影响哈希；数值变化影响", () => {
    const a = o();
    expect(outcomeHash({ ...a, fetchedAt: "2026-10-02T13:00:00.000Z", publishedAt: "2026-10-02T12:31:00.000Z" })).toBe(outcomeHash(a));
    expect(outcomeHash({ ...a, metrics: [...a.metrics].reverse() })).toBe(outcomeHash(a));
    expect(outcomeHash({ ...a, metrics: a.metrics.map((m, i) => (i === 0 ? { ...m, actual: "112" } : m)) })).not.toBe(outcomeHash(a));
  });
  it("首次 → data_arrived/0；同哈希 → unchanged；变化 → revised/+1；无 outcome → none", () => {
    const a = o();
    const first = deriveOutcomeChange(null, a);
    expect(first).toMatchObject({ kind: "data_arrived", outcomeRevision: 0 });
    expect(deriveOutcomeChange({ hash: first.kind === "data_arrived" ? first.hash : "", outcomeRevision: 0 }, a)).toMatchObject({ kind: "unchanged", outcomeRevision: 0 });
    const b = { ...a, metrics: a.metrics.map((m, i) => (i === 0 ? { ...m, actual: "112" } : m)) };
    expect(deriveOutcomeChange({ hash: outcomeHash(a), outcomeRevision: 0 }, b)).toMatchObject({ kind: "revised", outcomeRevision: 1 });
    expect(deriveOutcomeChange({ hash: outcomeHash(a), outcomeRevision: 0 }, undefined)).toEqual({ kind: "none" });
  });
});

describe("D-04 无预期值不出现「超预期 / 不及预期」", () => {
  const metric = (over: Partial<EventOutcomeMetric> = {}): EventOutcomeMetric => ({ key: "payrolls_change", label: "x", actual: "111", unit: "thousands", period: "2026-09", ...over });
  it("没有 expectation → no_expectation、标签 null；有 → 只给方向", () => {
    expect(compareToExpectation(metric())).toEqual({ kind: "no_expectation", key: "payrolls_change" });
    expect(expectationLabel(metric())).toBeNull();
    const exp = (value: string) => metric({ expectation: { value, kind: "survey", source: "fixture.survey", at: "2026-10-01T00:00:00.000Z" } });
    expect(expectationLabel(exp("100"))).toBe("above_expectation");
    expect(expectationLabel(exp("111.0"))).toBe("in_line");
    expect(expectationLabel(exp("200"))).toBe("below_expectation");
    expect(compareToExpectation(exp("100"))).toMatchObject({ direction: "above", expectationKind: "survey", expectationSource: "fixture.survey" });
  });
  it("文本守卫：无预期值时拦下 beat / miss / 超预期 / 不及预期；有预期值时不拦；普通文本不误伤", () => {
    const fixtureOutcome = (validateEventOutcome(arrivedOutcome()) as { ok: true; outcome: EventOutcome }).outcome;
    expect(unsupportedSurpriseTerms("Payrolls beat expectations", fixtureOutcome)).toEqual(["beat"]);
    expect(unsupportedSurpriseTerms("非农超预期，失业率不及预期", fixtureOutcome)).toEqual(["超预期", "不及预期"]);
    expect(unsupportedSurpriseTerms("came in above consensus", null)).toEqual(["above consensus"]);
    expect(unsupportedSurpriseTerms("Payrolls change 111k; data missing for revisions is not assumed", fixtureOutcome)).toEqual([]);
    const withExp: EventOutcome = { ...fixtureOutcome, metrics: [{ ...fixtureOutcome.metrics[0]!, expectation: { value: "100", kind: "survey", source: "s", at: "2026-10-01T00:00:00.000Z" } }] };
    expect(unsupportedSurpriseTerms("beat expectations", withExp)).toEqual([]);
  });
  it("十进制比较不经浮点", () => {
    expect(compareDecimalStrings("0.1", "0.10")).toBe(0);
    expect(compareDecimalStrings("-0", "0")).toBe(0);
    expect(compareDecimalStrings("-1.5", "-1.4")).toBe(-1);
    expect(compareDecimalStrings("10", "9.999")).toBe(1);
    expect(compareDecimalStrings("12345678901234567890.1", "12345678901234567890.09")).toBe(1);
    expect(() => compareDecimalStrings("1e3", "1")).toThrow();
  });
});
