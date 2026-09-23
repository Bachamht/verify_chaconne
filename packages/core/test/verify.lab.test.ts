/**
 * Lane E · 决策实验（C9）核心纯函数：L-01～L-06。
 * 求值器用 Lane E 参考实现（四种条件）；期望值按 interfaces §11.4/§11.5 与上游 §6「回放口径」手工推导，不由被测函数生成。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildConditionSet,
  buildEvidenceSnapshot,
  comparePolicies,
  conditionSetHash,
  createReferenceEvaluator,
  eventsKnownAsOf,
  explainWait,
  etToUtc,
  nextAllowedSessionStart,
  runReplay,
  tradingDaysBetween,
  type Condition,
  type ConditionEvidenceInput,
  type ConditionTaskState,
  type CtxField,
  type EvidenceRecord,
  type MarketContext,
  type MarketEvent,
  type PlanGoal,
  type ReplayArchive,
} from "../src/verify";
import { FIXTURE_OWNER, FIXTURE_RECIPIENT, FIXTURE_STABLE_KEY, FIXTURE_STOCK_KEY, quoteEvidence, T_REGULAR } from "../src/verify/fixtures";

/* ---------- 构造器（最小上下文；不凭记忆写任何外部数值，全部是占位） ---------- */
const field = <T,>(value: T | null, fetchedAt: string, status: CtxField<T>["status"] = "ok", note?: string): CtxField<T> => ({ value, source: "test", observedAt: fetchedAt, fetchedAt, status, purposes: ["agent"], ...(note ? { note } : {}) });
function ctx(packagedAt: string, vix: string | null, vixStatus: CtxField<string>["status"] = "ok"): MarketContext {
  const f = <T,>(v: T) => field<T>(v, packagedAt);
  const num = field<string>(null, packagedAt);
  const str = field<string | null>(null, packagedAt);
  return {
    schemaVersion: "chaconne-context/1",
    producer: "crowsnest",
    packagedAt,
    signature: "0x00",
    signatureAlg: "ed25519",
    publicKeyId: "test",
    session: { label: f<"US_REGULAR">("US_REGULAR"), usTradingDay: f(true), holiday: str, earlyClose: f(false), hoursToUsOpen: f("0"), hoursToUsClose: f("3"), etDate: f(packagedAt.slice(0, 10)) },
    events: [],
    fed: { blackout: f(false), blackoutUntil: field<string | null>(null, packagedAt), hikeProb: f("0"), hikeProbDrift24hPp: f("0") },
    rates: { y2: num, y10: num, y30: num, s2s30Bp: num, curveShape: str, realYield10: num, move: num },
    risk: { vix: field<string>(vix, packagedAt, vixStatus), nqOvernightPct: num, esOvernightPct: num, dxy: num, dxyPct1d: num },
    crossAsset: { lastDataRelease: field<{ eventId: string; state: "relief"; atUtc: string } | null>(null, packagedAt) },
    driftVerdict: field<string>(null, packagedAt),
  };
}
function event(id: string, revision: number, scheduledAtUtc: string, firstKnownAt: string, extra: Partial<MarketEvent> = {}): MarketEvent {
  return { id, kind: "MACRO_TIER1", name: "test event", underlyingIds: [], scheduledAtUtc, dateLocal: scheduledAtUtc.slice(0, 10), datePrecision: "exact", sessionHint: null, status: revision > 1 ? "revised" : "confirmed", revision, source: "test", sourceFetchedAt: firstKnownAt, firstKnownAt, tz: "America/New_York", ...extra };
}
function ctxEvidence(id: string, receivedAt: string, packagedAt: string): EvidenceRecord {
  return { evidenceId: id, provider: "crowsnest", endpoint: "/context/latest.json", requestFingerprint: "ctx", time: { requestedAt: receivedAt, receivedAt, sourcePublishedAt: packagedAt, sourceTimeKind: "published" }, block: null, rawHash: `0x${"11".repeat(32)}`, parserVersion: "test", mode: "FIXTURE", payload: { kind: "market_context", schemaVersion: "chaconne-context/1", producer: "crowsnest", packagedAt, publicKeyId: "test", signatureValid: true, contextHash: `0x${"22".repeat(32)}`, fieldStatus: {} } };
}
const state0: ConditionTaskState = { lastConfirmedStepAt: null, stepsConfirmedToday: 0, stepsConfirmed: 0 };
const ev = createReferenceEvaluator();
// T_REGULAR = 2026-09-18T15:00Z = 11:00 ET 周五（常规时段）
const NOW = T_REGULAR;

/** L-05 黑名单：任何响应对象里不得出现收益类字段名 */
const PROFIT_KEYS = /^(pnl|profit|return|returns|yield|gain|gains|roi|winrate|win_rate|sharpe|drawdown|cagr|apy|apr)$/i;
function scanKeys(v: unknown, path = ""): string[] {
  if (Array.isArray(v)) return v.flatMap((x, i) => scanKeys(x, `${path}[${i}]`));
  if (v && typeof v === "object") return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => (PROFIT_KEYS.test(k) ? [`${path}.${k}`] : scanKeys(x, `${path}.${k}`)));
  return [];
}

describe("Lane E · 参考求值器与时间工具", () => {
  it("etToUtc 夏令时/标准时各一例（9 月 = EDT -4，1 月 = EST -5）", () => {
    expect(etToUtc("2026-09-18", 9, 30)).toBe("2026-09-18T13:30:00.000Z");
    expect(etToUtc("2026-01-15", 9, 30)).toBe("2026-01-15T14:30:00.000Z");
  });
  it("tradingDaysBetween 跨周末与假日（9/7 Labor Day）", () => {
    expect(tradingDaysBetween("2026-09-04", "2026-09-08")).toBe(1); // 周五 → 周二：周一假日不算
    expect(tradingDaysBetween("2026-09-18", "2026-09-21")).toBe(1);
  });
  it("session：常规时段满足；盘后 → SESSION_RULE_BLOCK 且 nextCheckAt = 下一交易日 09:30 ET", () => {
    const set = buildConditionSet([{ type: "session", allow: ["US_REGULAR"] }]);
    const empty: ConditionEvidenceInput = { records: [], context: null, events: [] };
    expect(ev.evaluate(set, empty, state0, NOW).outcome).toBe("SATISFIED");
    const post = ev.evaluate(set, empty, state0, "2026-09-18T21:00:00.000Z");
    expect(post.outcome).toBe("UNSATISFIED");
    expect(post.perItem[0]!.reasons[0]!.code).toBe("SESSION_RULE_BLOCK");
    expect(post.nextCheckAt).toBe("2026-09-21T13:30:00.000Z");
    expect(nextAllowedSessionStart("2026-09-18T21:00:00.000Z", ["US_REGULAR"])).toBe("2026-09-21T13:30:00.000Z");
  });
  it("未覆盖的条件类型 → INSUFFICIENT_EVIDENCE（参考实现绝不放行）", () => {
    const set = buildConditionSet([{ type: "cash_floor", inputAssetKey: FIXTURE_STABLE_KEY, floorRaw: "1" }]);
    const r = ev.evaluate(set, { records: [], context: null, events: [] }, state0, NOW);
    expect(r.outcome).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.perItem[0]!.reasons[0]!.detail?.["unsupportedByReferenceEvaluator"]).toBe(true);
  });
  it("conditionSetHash 与 canonical 约定一致：顺序敏感、可复算", () => {
    const a = conditionSetHash([{ type: "session", allow: ["US_REGULAR"] }, { type: "max_vix", value: 30 }]);
    const b = conditionSetHash([{ type: "session", allow: ["US_REGULAR"] }, { type: "max_vix", value: 30 }]);
    const c = conditionSetHash([{ type: "max_vix", value: 30 }, { type: "session", allow: ["US_REGULAR"] }]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("L-01 等待诊断列全部阻塞项与下次检查点", () => {
  it("三条同时阻塞 → 三个 blocker（不止第一个）；已知恢复点取最小；未知项 text 说明为什么未知；userActionRequired 子集正确", () => {
    const set = buildConditionSet([
      { type: "session", allow: ["US_REGULAR"] },
      { type: "max_vix", value: 20 },
      { type: "avoid_event_window", kinds: ["MACRO_TIER1"], beforeMin: 30, afterMin: 20, includeEstimated: true, wholeDayIfDayPrecision: false },
      { type: "min_gap_trading_days", days: 1 },
    ]);
    const now = "2026-09-18T21:00:00.000Z"; // 盘后
    const packagedAt = "2026-09-18T20:55:00.000Z";
    const evidence: ConditionEvidenceInput = {
      records: [ctxEvidence("ev_ctx1", "2026-09-18T20:56:00.000Z", packagedAt)],
      context: ctx(packagedAt, "28.5"),
      // 只有日期精度、用户未预选整日 → EVENT_DATE_UNCERTAIN（需用户处理）
      events: [event("test:MACRO_TIER1:2026-09-18:cpi", 1, "2026-09-18T12:30:00.000Z", "2026-09-01T00:00:00.000Z", { datePrecision: "day", scheduledAtUtc: null })],
    };
    const r = ev.evaluate(set, evidence, state0, now);
    const x = explainWait(r, evidence, "zh");
    const codes = x.blockers.map((b) => b.code).sort();
    expect(codes).toEqual(["EVENT_DATE_UNCERTAIN", "SESSION_RULE_BLOCK", "VOL_REGIME_EXCEEDED"]);
    expect(x.blockers.length).toBe(3);
    const session = x.blockers.find((b) => b.code === "SESSION_RULE_BLOCK")!;
    expect(session.nextCheckAt).toBe("2026-09-21T13:30:00.000Z");
    const vix = x.blockers.find((b) => b.code === "VOL_REGIME_EXCEEDED")!;
    expect(vix.nextCheckAt).toBeNull();
    expect(vix.evidenceAt).toBe("2026-09-18T20:56:00.000Z"); // 引用的 market_context 证据 receivedAt
    expect(vix.text).toContain("下次检查点未知");
    expect(vix.userActionRequired).toBe(false);
    const dateUnc = x.blockers.find((b) => b.code === "EVENT_DATE_UNCERTAIN")!;
    expect(dateUnc.userActionRequired).toBe(true);
    expect(x.userActionRequired.map((b) => b.code)).toEqual(["EVENT_DATE_UNCERTAIN"]);
    expect(x.nextCheckAt).toBe("2026-09-21T13:30:00.000Z");
    expect(x.nextCheckNote.zh).toContain("其它项没有已知时间");
    expect(x.i18n.length).toBe(3);
    expect(x.i18n.every((i) => i.en && i.zh)).toBe(true);
    // L-01 文案不含预测词
    for (const b of x.blockers) expect(b.text).not.toMatch(/预计|必成交|will rise|will fall|forecast/i);
  });
  it("min_gap_trading_days：上一步周五确认、周一 11:00 ET 检查 → 已过 1 个交易日满足；days=2 → 阻塞且 nextCheckAt = 周二 09:30 ET", () => {
    const st: ConditionTaskState = { lastConfirmedStepAt: "2026-09-18T15:00:00.000Z", stepsConfirmedToday: 0, stepsConfirmed: 1 };
    const mon = "2026-09-21T15:00:00.000Z";
    expect(ev.evaluate(buildConditionSet([{ type: "min_gap_trading_days", days: 1 }]), { records: [], context: null, events: [] }, st, mon).outcome).toBe("SATISFIED");
    const r = ev.evaluate(buildConditionSet([{ type: "min_gap_trading_days", days: 2 }]), { records: [], context: null, events: [] }, st, mon);
    expect(r.outcome).toBe("UNSATISFIED");
    expect(r.nextCheckAt).toBe("2026-09-22T13:30:00.000Z");
  });
});

describe("L-02 对照用同一快照且不改真实任务", () => {
  const goal: PlanGoal = { ownerAddress: FIXTURE_OWNER, recipientAddress: FIXTURE_RECIPIENT, executionChainId: 196, legs: [{ outputAssetKey: FIXTURE_STOCK_KEY, weightBps: 10_000 }], budget: { inputAssetKeys: [FIXTURE_STABLE_KEY], amountInRaw: "100000000" }, side: "buy", policyId: "STRICT_LIVE", policyVersion: "1.1.0", maxSlippageBps: 50, maxPriceImpactBps: 100, maxReferenceDeviationBps: 300, deadline: "2026-09-19T15:00:00.000Z" };
  const packagedAt = "2026-09-18T14:58:00.000Z";
  const evidence: ConditionEvidenceInput = {
    records: [quoteEvidence({ receivedAt: "2026-09-18T14:59:58.000Z", id: "ev_q1" }), ctxEvidence("ev_ctx", "2026-09-18T14:59:00.000Z", packagedAt)],
    context: ctx(packagedAt, "18"),
    events: [event("test:MACRO_TIER1:2026-09-18:cpi", 1, "2026-09-18T14:45:00.000Z", "2026-09-01T00:00:00.000Z")],
  };
  it("同一证据 → 同一 evidenceSnapshotId；事件后 20 分钟 vs 40 分钟：一套放行一套等待；diff 只列不同的项；mode=SIMULATION", () => {
    const s1 = buildEvidenceSnapshot("task_1", NOW, evidence);
    const s2 = buildEvidenceSnapshot("task_1", NOW, { ...evidence, records: [...evidence.records] });
    expect(s1.id).toBe(s2.id);
    expect(s1.id).toMatch(/^snap_[0-9a-f]{24}$/);
    const base: Condition[] = [{ type: "session", allow: ["US_REGULAR"] }, { type: "max_vix", value: 30 }];
    const a = buildConditionSet([...base, { type: "avoid_event_window", kinds: ["MACRO_TIER1"], beforeMin: 30, afterMin: 20, includeEstimated: true, wholeDayIfDayPrecision: true }]);
    const b = buildConditionSet([...base, { type: "avoid_event_window", kinds: ["MACRO_TIER1"], beforeMin: 30, afterMin: 40, includeEstimated: true, wholeDayIfDayPrecision: true }]);
    const before = JSON.stringify(s1);
    const r = comparePolicies({ taskId: "task_1", snapshot: s1, variants: [{ label: "wait20", conditions: a }, { label: "wait40", conditions: b }], evaluator: ev, taskState: state0, goal });
    expect(JSON.stringify(s1)).toBe(before); // 快照未被改动
    expect(r.comparison.evidenceSnapshotId).toBe(s1.id);
    expect(r.comparison.mode).toBe("SIMULATION");
    expect(r.mode).toBe("SIMULATION");
    // 事件 14:45Z，now 15:00Z：+15 分钟 → 20 分钟窗口内（等待）；40 分钟窗口内也等待？不：两套都在窗口内 → 改用事件 14:30Z 校验差异
    expect(r.comparison.variants.map((v) => v.outcome)).toEqual(["UNSATISFIED", "UNSATISFIED"]);
    expect(r.comparison.diff.map((d) => d.itemType)).toEqual(["avoid_event_window"]);
    expect((r.comparison.diff[0]!.a as { afterMin: number }).afterMin).toBe(20);
    expect((r.comparison.diff[0]!.b as { afterMin: number }).afterMin).toBe(40);
  });
  it("事件 14:30Z、now 15:00Z：wait20 放行、wait40 等待到 15:10Z；同输入两次对照结果字节一致（可复算）", () => {
    const evidence2: ConditionEvidenceInput = { ...evidence, events: [event("test:MACRO_TIER1:2026-09-18:cpi", 1, "2026-09-18T14:30:00.000Z", "2026-09-01T00:00:00.000Z")] };
    const snap = buildEvidenceSnapshot("task_1", NOW, evidence2);
    const mk = (afterMin: number) => buildConditionSet([{ type: "session", allow: ["US_REGULAR"] }, { type: "avoid_event_window", kinds: ["MACRO_TIER1"], beforeMin: 30, afterMin, includeEstimated: true, wholeDayIfDayPrecision: true }]);
    const input = { taskId: "task_1", snapshot: snap, variants: [{ label: "wait20", conditions: mk(20) }, { label: "wait40", conditions: mk(40) }] as [never, never], evaluator: ev, taskState: state0, goal };
    const r1 = comparePolicies(input as unknown as Parameters<typeof comparePolicies>[0]);
    const r2 = comparePolicies(input as unknown as Parameters<typeof comparePolicies>[0]);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
    expect(r1.outcomeDiff.map((o) => o.outcome)).toEqual(["SATISFIED", "UNSATISFIED"]);
    expect(r1.outcomeDiff[1]!.nextCheckAt).toBe("2026-09-18T15:10:00.000Z");
    expect(r1.outcomeDiff[1]!.blockingCodes).toEqual(["EVENT_WINDOW_ACTIVE"]);
    // L-06：翻创 body 指向放行的那套，带 labConditions，且是可 POST /v1/simulations 的形态（含 legs/budget/policy，不含 deadline 与授权）
    expect(r1.remix.variantLabel).toBe("wait20");
    const body = r1.remix.simulationBody!;
    expect(body.labConditions.hash).toBe(mk(20).hash);
    expect(body.legs).toEqual(goal.legs);
    expect(body.budget).toEqual(goal.budget);
    expect(body.policyId).toBe("STRICT_LIVE");
    expect("deadline" in body).toBe(false);
    expect("mandate" in body || "signature" in body).toBe(false);
    expect(body.clientRequestId).toMatch(/^remix-cmp_/);
  });
});

describe("L-03 回放无前视（事件按 firstKnownAt）", () => {
  it("后来才可知的修订（改期）在评估点 t 之前不被使用；之后被使用", () => {
    const v1 = event("test:MACRO_TIER1:2026-09-18:cpi", 1, "2026-09-18T14:30:00.000Z", "2026-09-01T00:00:00.000Z");
    // 修订：改到 15:30Z，但 9/18 15:05Z 才首次可知
    const v2 = event("test:MACRO_TIER1:2026-09-18:cpi", 2, "2026-09-18T15:30:00.000Z", "2026-09-18T15:05:00.000Z", { revisedFrom: { scheduledAtUtc: v1.scheduledAtUtc, dateLocal: v1.dateLocal } });
    expect(eventsKnownAsOf([v1, v2], "2026-09-18T15:00:00.000Z").map((e) => e.revision)).toEqual([1]);
    expect(eventsKnownAsOf([v1, v2], "2026-09-18T15:05:00.000Z").map((e) => e.revision)).toEqual([2]);
    expect(eventsKnownAsOf([v2], "2026-09-18T15:00:00.000Z")).toEqual([]);

    const set = buildConditionSet([{ type: "session", allow: ["US_REGULAR"] }, { type: "avoid_event_window", kinds: ["MACRO_TIER1"], beforeMin: 30, afterMin: 20, includeEstimated: true, wholeDayIfDayPrecision: true }]);
    const archive: ReplayArchive = {
      records: [],
      contextSnapshots: [{ receivedAt: "2026-09-18T13:00:00.000Z", context: ctx("2026-09-18T13:00:00.000Z", "18") }],
      eventVersions: [v1, v2],
      referenceBars: [],
      referencePurged: [],
    };
    // 15:00Z：按 v1（14:30Z + 20 分钟 = 14:50Z 已过）→ 放行；若错误地用了 v2（15:30Z − 30 分钟 = 15:00Z 起窗口）→ 会被阻塞
    const r = runReplay({ id: "rp_1", playbookId: "session_dca", conditions: set, assetKey: FIXTURE_STOCK_KEY, from: "2026-09-18T15:00:00.000Z", to: "2026-09-18T15:20:00.000Z", stepMinutes: 10, archive, evaluator: ev, taskState: state0 });
    expect(r.mode).toBe("REPLAY");
    const p0 = r.run.points[0]!;
    expect(p0.t).toBe("2026-09-18T15:00:00.000Z");
    expect(p0.outcome).toBe("SATISFIED");
    expect(p0.knownAsOf <= p0.t).toBe(true);
    expect(p0.knownAsOf).toBe("2026-09-18T13:00:00.000Z"); // 用到的最晚可知时刻 = 上下文快照；v2(15:05) 未被用
    // 15:10Z：v2 已可知（15:05）→ 15:30Z 事件、窗口 15:00–15:50Z → 阻塞
    const p1 = r.run.points[1]!;
    expect(p1.outcome).toBe("UNSATISFIED");
    expect(p1.blockers[0]!.code).toBe("EVENT_WINDOW_ACTIVE");
    expect(p1.knownAsOf).toBe("2026-09-18T15:05:00.000Z");
    expect(p1.blockers[0]!.nextCheckAt).toBe("2026-09-18T15:50:00.000Z");
    for (const p of r.run.points) expect(p.knownAsOf <= p.t).toBe(true);
  });
});

describe("L-04 缺口与清空区间如实展示", () => {
  const set = buildConditionSet([{ type: "session", allow: ["US_REGULAR"] }, { type: "premium_bps_lte", value: 50, referenceKind: "live", liveOnlyForExecution: true }]);
  it("无档案时点 → NO_ARCHIVE 且不放行；无 quote 时点 → INSUFFICIENT + [NO_QUOTE]；断供清空 → REFERENCE_PURGED；coverage 标来源", () => {
    const archive: ReplayArchive = {
      records: [quoteEvidence({ receivedAt: "2026-09-18T15:59:00.000Z", id: "ev_q_1600" })],
      contextSnapshots: [{ receivedAt: "2026-09-18T15:30:00.000Z", context: ctx("2026-09-18T15:30:00.000Z", "18") }],
      eventVersions: [],
      referenceBars: [{ ts: "2026-09-18T15:00:00.000Z", refPriceUsd: 1, tokenPriceUsd: 1 }],
      referencePurged: [{ from: "2026-09-18T17:00:00.000Z", to: "2026-09-18T18:00:00.000Z" }],
    };
    const r = runReplay({ id: "rp_2", playbookId: "discount_watch", conditions: set, assetKey: FIXTURE_STOCK_KEY, from: "2026-09-18T14:00:00.000Z", to: "2026-09-18T18:00:00.000Z", stepMinutes: 60, archive, evaluator: ev, taskState: state0 });
    const at = (t: string) => r.run.points.find((p) => p.t === t)!;
    // 14:00Z：什么都没有 → NO_ARCHIVE，不放行
    expect(at("2026-09-18T14:00:00.000Z").outcome).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.run.gaps.some((g) => g.reason === "NO_ARCHIVE" && g.from === "2026-09-18T14:00:00.000Z")).toBe(true);
    // 16:00Z：有 quote（15:59）+ 上下文 → 但参考实现不支持 premium_bps_lte → INSUFFICIENT；不带 NO_QUOTE
    const p16 = at("2026-09-18T16:00:00.000Z");
    expect(p16.outcome).toBe("INSUFFICIENT_EVIDENCE");
    expect(p16.blockers.some((b) => b.text.includes("[NO_QUOTE]"))).toBe(false);
    // 17:00Z：quote 超出 5 分钟回看 → NO_QUOTE 阻塞项 + gap；且处于清空区间 → REFERENCE_PURGED
    const p17 = at("2026-09-18T17:00:00.000Z");
    expect(p17.outcome).toBe("INSUFFICIENT_EVIDENCE");
    expect(p17.blockers.some((b) => b.code === "QUOTE_UNAVAILABLE" && b.text.includes("[NO_QUOTE]"))).toBe(true);
    expect(r.run.gaps.some((g) => g.reason === "NO_QUOTE" && g.from <= "2026-09-18T17:00:00.000Z" && g.to >= "2026-09-18T18:00:00.000Z")).toBe(true);
    expect(r.run.gaps.filter((g) => g.reason === "REFERENCE_PURGED")).toEqual([{ from: "2026-09-18T17:00:00.000Z", to: "2026-09-18T18:00:00.000Z", reason: "REFERENCE_PURGED" }]);
    // coverage：15:00Z 只有 premium_1h 背景不算档案（无证据无上下文 → NO_ARCHIVE）；16:00Z 起有 verify_evidence + 上下文
    const cov16 = r.run.coverage.find((c) => c.from === "2026-09-18T16:00:00.000Z")!;
    expect(cov16.sources).toEqual(["verify_evidence", "verify_context_snapshots"]);
    expect(r.run.coverage.some((c) => c.from === "2026-09-18T15:00:00.000Z")).toBe(false);
    expect(r.sources).toEqual({ verify_evidence: 1, verify_context_snapshots: 1, premium_1h: 1, events: 0 });
  });
  it("空档案 → 全区间 NO_ARCHIVE、零 coverage、每点 INSUFFICIENT_EVIDENCE（不伪装）", () => {
    const archive: ReplayArchive = { records: [], contextSnapshots: [], eventVersions: [], referenceBars: [], referencePurged: [] };
    const r = runReplay({ id: "rp_3", playbookId: "session_dca", conditions: buildConditionSet([{ type: "session", allow: ["US_REGULAR"] }]), assetKey: FIXTURE_STOCK_KEY, from: "2026-09-18T14:00:00.000Z", to: "2026-09-18T16:00:00.000Z", stepMinutes: 60, archive, evaluator: ev, taskState: state0 });
    expect(r.run.coverage).toEqual([]);
    expect(r.run.gaps).toEqual([{ from: "2026-09-18T14:00:00.000Z", to: "2026-09-18T16:00:00.000Z", reason: "NO_ARCHIVE" }]);
    expect(r.run.points.every((p) => p.outcome === "INSUFFICIENT_EVIDENCE")).toBe(true);
  });
});

describe("L-05 不输出收益", () => {
  it("回放 / 对照 / 诊断的输出对象没有任何收益类字段名（黑名单扫描）", () => {
    const set = buildConditionSet([{ type: "session", allow: ["US_REGULAR"] }]);
    const archive: ReplayArchive = { records: [quoteEvidence({ receivedAt: "2026-09-18T14:59:00.000Z" })], contextSnapshots: [{ receivedAt: "2026-09-18T14:00:00.000Z", context: ctx("2026-09-18T14:00:00.000Z", "18") }], eventVersions: [], referenceBars: [{ ts: "2026-09-18T14:00:00.000Z", refPriceUsd: 1, tokenPriceUsd: 1.01 }], referencePurged: [] };
    const rp = runReplay({ id: "rp_4", playbookId: "session_dca", conditions: set, assetKey: FIXTURE_STOCK_KEY, from: "2026-09-18T14:00:00.000Z", to: "2026-09-18T16:00:00.000Z", archive, evaluator: ev, taskState: state0 });
    expect(scanKeys(rp)).toEqual([]);
    const snap = buildEvidenceSnapshot("task_1", NOW, { records: archive.records, context: archive.contextSnapshots[0]!.context, events: [] });
    const cmp = comparePolicies({ taskId: "task_1", snapshot: snap, variants: [{ label: "a", conditions: set }, { label: "b", conditions: buildConditionSet([{ type: "max_vix", value: 10 }]) }], evaluator: ev, taskState: state0, goal: null });
    expect(scanKeys(cmp)).toEqual([]);
    expect(cmp.remix.simulationBody).toBeNull(); // 无 goal → 不编造翻创体
    expect(scanKeys(explainWait(ev.evaluate(set, { records: [], context: null, events: [] }, state0, NOW), { records: [], context: null, events: [] }))).toEqual([]);
    // 黑名单本身有效
    expect(scanKeys({ a: { pnl: 1 } })).toEqual([".a.pnl"]);
  });
});

describe("CV-D12 / CV-D13：十进制字符串数值与 provenance（crowsnest 黄金样本 + 回填形态）", () => {
  const sample = JSON.parse(readFileSync(join(__dirname, "fixtures", "lab", "sample_context.json"), "utf8")) as MarketContext;
  const set = buildConditionSet([{ type: "max_vix", value: 20 }]);
  it("黄金样本 provenance.mode=sample：默认排除（当作无档案，NO_ARCHIVE）；allowSample 才用；+00:00 时间戳按毫秒比较；vix 字符串解析后比较", () => {
    expect(sample.provenance?.mode).toBe("sample");
    expect(typeof sample.risk.vix.value).toBe("string");
    expect(sample.packagedAt.endsWith("+00:00")).toBe(true);
    const archive: ReplayArchive = { records: [], contextSnapshots: [{ receivedAt: sample.packagedAt, context: sample }], eventVersions: sample.events, referenceBars: [], referencePurged: [] };
    const from = "2026-09-23T10:00:00.000Z";
    const to = "2026-09-23T12:00:00.000Z";
    const excluded = runReplay({ id: "rp_s1", playbookId: "session_dca", conditions: set, assetKey: FIXTURE_STOCK_KEY, from, to, stepMinutes: 60, archive, evaluator: ev, taskState: state0 });
    expect(excluded.contextProvenance).toEqual({ live: 0, backfill: 0, sample: 0, unknown: 0, excludedSample: 1 });
    expect(excluded.run.gaps).toEqual([{ from, to, reason: "NO_ARCHIVE" }]);
    expect(excluded.run.points.every((p) => p.outcome === "INSUFFICIENT_EVIDENCE")).toBe(true);
    const allowed = runReplay({ id: "rp_s2", playbookId: "session_dca", conditions: set, assetKey: FIXTURE_STOCK_KEY, from, to, stepMinutes: 60, archive, evaluator: ev, taskState: state0, allowSample: true });
    expect(allowed.mode).toBe("REPLAY");
    expect(allowed.contextProvenance.sample).toBe(3);
    expect(allowed.run.coverage).toEqual([{ from, to, sources: ["verify_context_snapshots"] }]);
    // 样本 vix "17.85" ≤ 20 → 满足；knownAsOf 归一成 Z 结尾 ISO 且 ≤ t
    expect(allowed.run.points[0]!.outcome).toBe("SATISFIED");
    expect(allowed.run.points[0]!.knownAsOf).toBe("2026-09-23T10:00:00.000Z");
    // 事件按 firstKnownAt（+00:00 格式）过滤：样本里 firstKnownAt ≤ t 的事件全部可见
    const known = eventsKnownAsOf(sample.events, from);
    expect(known.length).toBe(sample.events.filter((e) => Date.parse(e.firstKnownAt) <= Date.parse(from)).length);
    // 阈值 10 → "17.85" > 10 → VOL_REGIME_EXCEEDED（证明比较的是数值不是字符串）
    const strict = runReplay({ id: "rp_s3", playbookId: "session_dca", conditions: buildConditionSet([{ type: "max_vix", value: 10 }]), assetKey: FIXTURE_STOCK_KEY, from, to, stepMinutes: 60, archive, evaluator: ev, taskState: state0, allowSample: true });
    expect(strict.run.points[0]!.blockers[0]!.code).toBe("VOL_REGIME_EXCEEDED");
  });
  it("回填形态（mode=backfill，VIX unavailable）：max_vix → INSUFFICIENT_EVIDENCE / CONTEXT_UNAVAILABLE；产出标 REPLAY 且 provenance 计入 backfill", () => {
    const backfill: MarketContext = { ...sample, packagedAt: "2026-09-18T14:00:00+00:00", provenance: { mode: "backfill" }, risk: { ...sample.risk, vix: { ...sample.risk.vix, value: null, observedAt: null, status: "unavailable", note: "回填源 ticks 无此字段" } } };
    const archive: ReplayArchive = { records: [], contextSnapshots: [{ receivedAt: "2026-09-18T14:00:00+00:00", context: backfill }], eventVersions: [], referenceBars: [], referencePurged: [] };
    const r = runReplay({ id: "rp_b1", playbookId: "session_dca", conditions: set, assetKey: FIXTURE_STOCK_KEY, from: "2026-09-18T14:00:00.000Z", to: "2026-09-18T15:00:00.000Z", stepMinutes: 60, archive, evaluator: ev, taskState: state0 });
    expect(r.mode).toBe("REPLAY");
    expect(r.contextProvenance.backfill).toBe(2);
    expect(r.run.points[0]!.outcome).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.run.points[0]!.blockers[0]!.code).toBe("CONTEXT_UNAVAILABLE");
    expect(r.run.gaps).toEqual([]); // 有档案，只是字段不可用：不是 NO_ARCHIVE
    expect(JSON.stringify(r)).not.toMatch(/"LIVE"/);
  });
  it("vix 值解析不了（非数字串）→ 证据不足，不猜", () => {
    const bad = ctx("2026-09-18T14:00:00.000Z", "n/a");
    const r = ev.evaluate(set, { records: [], context: bad, events: [] }, state0, "2026-09-18T14:00:00.000Z");
    expect(r.outcome).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.perItem[0]!.reasons[0]!.detail?.["unparsableValue"]).toBe("n/a");
  });
});
