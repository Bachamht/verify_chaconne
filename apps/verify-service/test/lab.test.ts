/**
 * Lane E · 决策实验（C9）HTTP 层：L-01～L-06 + 鉴权 + 开关 + 三类数据源读取。
 * 任务由内存 TaskReader 提供（Lane B 合并后换正式实现，接口不变）；求值器为参考实现。
 */
import { afterEach, describe, expect, it } from "vitest";
import { assets, premium1h, verifyEvidence, verifyMandates } from "@chaconne/db";
import { buildConditionSet, type CtxField, type EvidenceRecord, type LabTaskRecord, type MarketContext, type MarketEvent, type PlanGoal, type ReplayArchive } from "@chaconne/core/verify";
import { FIXTURE_OWNER, FIXTURE_RECIPIENT, FIXTURE_STABLE, FIXTURE_STABLE_KEY, FIXTURE_STOCK, FIXTURE_STOCK_KEY, quoteEvidence } from "@chaconne/core/verify/fixtures";
import { api, createTestEnv, OTHER_API_KEY, TEST_CALLER, type TestEnv } from "./helpers";
import { derivePurgedRanges, DbReplayArchive } from "../src/lab/archive";

let env: TestEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

/* ---------- 构造 ---------- */
const NOW = "2026-09-21T15:00:00.000Z"; // 周一 11:00 ET，常规时段
const field = <T,>(value: T | null, at: string, status: CtxField<T>["status"] = "ok"): CtxField<T> => ({ value, source: "test", observedAt: at, fetchedAt: at, status, purposes: ["agent"] });
function ctx(packagedAt: string, vix: string | null): MarketContext {
  const f = <T,>(v: T) => field<T>(v, packagedAt);
  const num = field<string>(null, packagedAt);
  const str = field<string | null>(null, packagedAt);
  return { schemaVersion: "chaconne-context/1", producer: "crowsnest", packagedAt, signature: "0x00", signatureAlg: "ed25519", publicKeyId: "test", session: { label: f<"US_REGULAR">("US_REGULAR"), usTradingDay: f(true), holiday: str, earlyClose: f(false), hoursToUsOpen: f("0"), hoursToUsClose: f("5"), etDate: f(packagedAt.slice(0, 10)) }, events: [], fed: { blackout: f(false), blackoutUntil: str, hikeProb: f("0"), hikeProbDrift24hPp: f("0") }, rates: { y2: num, y10: num, y30: num, s2s30Bp: num, curveShape: str, realYield10: num, move: num }, risk: { vix: field<string>(vix, packagedAt), nqOvernightPct: num, esOvernightPct: num, dxy: num, dxyPct1d: num }, crossAsset: { lastDataRelease: field<{ eventId: string; state: "relief"; atUtc: string } | null>(null, packagedAt) }, driftVerdict: field<string>(null, packagedAt) };
}
function event(id: string, revision: number, scheduledAtUtc: string, firstKnownAt: string): MarketEvent {
  return { id, kind: "MACRO_TIER1", name: "test", underlyingIds: [], scheduledAtUtc, dateLocal: scheduledAtUtc.slice(0, 10), datePrecision: "exact", sessionHint: null, status: revision > 1 ? "revised" : "confirmed", revision, source: "test", sourceFetchedAt: firstKnownAt, firstKnownAt, tz: "America/New_York" };
}
function ctxEvidence(id: string, receivedAt: string, packagedAt: string): EvidenceRecord {
  return { evidenceId: id, provider: "crowsnest", endpoint: "/context/latest.json", requestFingerprint: "ctx", time: { requestedAt: receivedAt, receivedAt, sourcePublishedAt: packagedAt, sourceTimeKind: "published" }, block: null, rawHash: `0x${"11".repeat(32)}`, parserVersion: "test", mode: "FIXTURE", payload: { kind: "market_context", schemaVersion: "chaconne-context/1", producer: "crowsnest", packagedAt, publicKeyId: "test", signatureValid: true, contextHash: `0x${"22".repeat(32)}`, fieldStatus: {} } };
}
const goal: PlanGoal = { ownerAddress: FIXTURE_OWNER, recipientAddress: FIXTURE_RECIPIENT, executionChainId: 196, legs: [{ outputAssetKey: FIXTURE_STOCK_KEY, weightBps: 10_000 }], budget: { inputAssetKeys: [FIXTURE_STABLE_KEY], amountInRaw: "100000000" }, side: "buy", policyId: "STRICT_LIVE", policyVersion: "1.1.0", maxSlippageBps: 50, maxPriceImpactBps: 100, maxReferenceDeviationBps: 300, deadline: "2026-09-22T15:00:00.000Z" };

/** 一个 WAITING 的 session_dca 任务：最近一次评估在 NOW−1 分钟，证据 = 报价 + 上下文（vix 28）+ 一个 14:50Z 的一级宏观事件 */
function waitingTask(id = "task_lab_1", opts: { withEvaluation?: boolean } = {}): LabTaskRecord {
  const at = "2026-09-21T14:59:00.000Z";
  const conditions = buildConditionSet([
    { type: "session", allow: ["US_REGULAR"] },
    { type: "min_gap_trading_days", days: 1 },
    { type: "max_vix", value: 20 },
    { type: "avoid_event_window", kinds: ["MACRO_TIER1"], beforeMin: 30, afterMin: 20, includeEstimated: true, wholeDayIfDayPrecision: true },
  ]);
  return {
    task: { id, owner: FIXTURE_OWNER, playbookId: "session_dca", goal, conditions, mandateIds: [], status: "WAITING", blockers: [], nextCheckAt: null, executorPresence: "offline", createdAt: "2026-09-21T14:00:00.000Z", updatedAt: at },
    callerId: TEST_CALLER,
    taskState: { lastConfirmedStepAt: null, stepsConfirmedToday: 0, stepsConfirmed: 0 },
    goal,
    latestEvaluation: opts.withEvaluation === false ? null : {
      evaluatedAt: at,
      evaluation: null, // 让服务用注入的求值器展开（B 落地后这里是 B 的 ConditionEvaluation）
      evidence: {
        records: [quoteEvidence({ receivedAt: "2026-09-21T14:58:58.000Z", amountInRaw: "100000000", fromToken: FIXTURE_STABLE, toToken: FIXTURE_STOCK, id: "ev_q_lab" }), ctxEvidence("ev_ctx_lab", "2026-09-21T14:58:30.000Z", "2026-09-21T14:58:00.000Z")],
        context: ctx("2026-09-21T14:58:00.000Z", "28"),
        events: [event("test:MACRO_TIER1:2026-09-21:cpi", 1, "2026-09-21T14:50:00.000Z", "2026-09-01T00:00:00.000Z")],
      },
    },
  };
}
const PROFIT_KEYS = /^(pnl|profit|return|returns|yield|gain|gains|roi|winrate|win_rate|sharpe|drawdown|cagr|apy|apr)$/i;
function scanKeys(v: unknown, path = ""): string[] {
  if (Array.isArray(v)) return v.flatMap((x, i) => scanKeys(x, `${path}[${i}]`));
  if (v && typeof v === "object") return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => (PROFIT_KEYS.test(k) ? [`${path}.${k}`] : scanKeys(x, `${path}.${k}`)));
  return [];
}
const twoVariants = (afterA: number, afterB: number) => ({
  variants: [
    { label: `wait${afterA}`, conditions: { items: [{ type: "session", allow: ["US_REGULAR"] }, { type: "avoid_event_window", kinds: ["MACRO_TIER1"], beforeMin: 30, afterMin: afterA, includeEstimated: true, wholeDayIfDayPrecision: true }] } },
    { label: `wait${afterB}`, conditions: { items: [{ type: "session", allow: ["US_REGULAR"] }, { type: "avoid_event_window", kinds: ["MACRO_TIER1"], beforeMin: 30, afterMin: afterB, includeEstimated: true, wholeDayIfDayPrecision: true }] } },
  ],
});

describe("L-01 GET /v1/tasks/:id/explain-wait", () => {
  it("返回全部阻塞项（vix + 事件窗口两项）、证据时间、nextCheckAt 与 userActionRequired；owner 鉴权 403；不存在 404", async () => {
    env = await createTestEnv({ now: NOW, extraKeys: "vk_web:web*" });
    env.labTasks.put(waitingTask());
    const r = await api(env, "GET", "/v1/tasks/task_lab_1/explain-wait?locale=zh");
    expect(r.status).toBe(200);
    expect(r.json["taskId"]).toBe("task_lab_1");
    expect(r.json["source"]).toBe("evaluated_now");
    expect(r.json["evidenceSnapshotId"]).toMatch(/^snap_/);
    const blockers = r.json["blockers"] as Array<{ code: string; evidenceAt: string | null; nextCheckAt: string | null; userActionRequired: boolean; text: string }>;
    expect(blockers.map((b) => b.code).sort()).toEqual(["EVENT_WINDOW_ACTIVE", "VOL_REGIME_EXCEEDED"]);
    const win = blockers.find((b) => b.code === "EVENT_WINDOW_ACTIVE")!;
    expect(win.nextCheckAt).toBe("2026-09-21T15:10:00.000Z"); // 14:50Z + 20 分钟
    const vix = blockers.find((b) => b.code === "VOL_REGIME_EXCEEDED")!;
    expect(vix.nextCheckAt).toBeNull();
    expect(vix.evidenceAt).toBe("2026-09-21T14:58:30.000Z");
    expect(vix.text).toMatch(/下次检查点未知/);
    expect(r.json["nextCheckAt"]).toBe("2026-09-21T15:10:00.000Z");
    expect(r.json["userActionRequired"]).toEqual([]);
    expect((r.json["i18n"] as unknown[]).length).toBe(2);
    // 另一个 API key 调用方 → 403；web:<owner> 调用方 → 200；web:<别人> → 403
    expect((await api(env, "GET", "/v1/tasks/task_lab_1/explain-wait", undefined, {}, OTHER_API_KEY)).status).toBe(403);
    expect((await api(env, "GET", "/v1/tasks/task_lab_1/explain-wait", undefined, { "x-verify-caller": FIXTURE_OWNER }, "vk_web")).status).toBe(200);
    expect((await api(env, "GET", "/v1/tasks/task_lab_1/explain-wait", undefined, { "x-verify-caller": "0x9999999999999999999999999999999999999999" }, "vk_web")).status).toBe(403);
    expect((await api(env, "GET", "/v1/tasks/nope/explain-wait")).status).toBe(404);
  });
});

describe("L-02 POST /v1/tasks/:id/compare-policies", () => {
  it("同一快照、SIMULATION、逐项 diff；两次对照同 comparisonId 与同结果；真实任务与授权表都不变", async () => {
    env = await createTestEnv({ now: NOW });
    env.labTasks.put(waitingTask());
    const before = JSON.stringify(env.labTasks.raw("task_lab_1"));
    const r1 = await api(env, "POST", "/v1/tasks/task_lab_1/compare-policies", twoVariants(5, 40));
    expect(r1.status).toBe(201);
    expect(r1.json["mode"]).toBe("SIMULATION");
    const cmp = r1.json["comparison"] as { id: string; evidenceSnapshotId: string; mode: string; variants: Array<{ label: string; outcome: string }>; diff: Array<{ itemType: string }> };
    expect(cmp.mode).toBe("SIMULATION");
    expect(cmp.evidenceSnapshotId).toBe(r1.json["evidenceSnapshotId"] ?? cmp.evidenceSnapshotId);
    expect((r1.json["snapshot"] as { id: string }).id).toBe(cmp.evidenceSnapshotId);
    // 事件 14:50Z、评估时刻 14:59Z：+9 分钟 → wait5 放行、wait40 等待
    expect(cmp.variants.map((v) => v.outcome)).toEqual(["SATISFIED", "UNSATISFIED"]);
    expect(cmp.diff.map((d) => d.itemType)).toEqual(["avoid_event_window"]);
    // 规划器用了同一 quote 证据（阶梯首档 100 USDG 有报价 → 有候选）
    const planner = r1.json["planner"] as Array<{ label: string; summary: { planHash: string; candidateCount: number } | null }>;
    expect(planner.length).toBe(2);
    expect(planner[0]!.summary).not.toBeNull();
    expect(planner[0]!.summary!.planHash).toBe(planner[1]!.summary!.planHash); // 同证据 → 同规划
    // 真实任务未改；没有写任何授权
    expect(JSON.stringify(env.labTasks.raw("task_lab_1"))).toBe(before);
    expect((r1.json["task"] as { status: string; mandateIds: string[] })).toEqual({ id: "task_lab_1", status: "WAITING", conditionsHash: env.labTasks.raw("task_lab_1")!.task.conditions.hash, mandateIds: [] });
    expect((await env.db.select().from(verifyMandates)).length).toBe(0);
    // 可复算：同输入再来一次 → 同 id、同 snapshot、同结果
    const r2 = await api(env, "POST", "/v1/tasks/task_lab_1/compare-policies", twoVariants(5, 40));
    expect(r2.status).toBe(201);
    expect(r2.json["comparisonId"]).toBe(r1.json["comparisonId"]);
    expect(JSON.stringify(r2.json["comparison"])).toBe(JSON.stringify(r1.json["comparison"]));
    // L-06：翻创体
    const remix = r1.json["remix"] as { variantLabel: string; simulationBody: Record<string, unknown> | null };
    expect(remix.variantLabel).toBe("wait5");
    expect(remix.simulationBody).not.toBeNull();
    expect(remix.simulationBody!["legs"]).toEqual(goal.legs);
    expect(remix.simulationBody!["labConditions"]).toBeTruthy();
    expect("deadline" in remix.simulationBody!).toBe(false);
  });
  it("L-06 翻创体可直接 POST /v1/simulations 得到 SIMULATION（不签证书、不执行）", async () => {
    env = await createTestEnv({ now: NOW });
    env.labTasks.put(waitingTask());
    const r1 = await api(env, "POST", "/v1/tasks/task_lab_1/compare-policies", twoVariants(5, 40));
    const body = (r1.json["remix"] as { simulationBody: Record<string, unknown> }).simulationBody;
    const sim = await api(env, "POST", "/v1/simulations", body);
    expect(sim.status).toBe(201);
    expect(sim.json["mode"]).toBe("SIMULATION");
    expect(sim.json["certificatesIssued"]).toBe(0);
    expect(sim.json["executions"]).toEqual([]);
  });
  it("校验：非两套 → 400；hash 不一致 → 400；未知条件类型 → 400；任务无评估 → 409；他人 → 403", async () => {
    env = await createTestEnv({ now: NOW });
    env.labTasks.put(waitingTask());
    env.labTasks.put(waitingTask("task_lab_noeval", { withEvaluation: false }));
    const one = await api(env, "POST", "/v1/tasks/task_lab_1/compare-policies", { variants: [twoVariants(5, 40).variants[0]] });
    expect(one.status).toBe(400);
    const bad = twoVariants(5, 40);
    (bad.variants[0]!.conditions as { hash?: string }).hash = `0x${"00".repeat(32)}`;
    expect((await api(env, "POST", "/v1/tasks/task_lab_1/compare-policies", bad)).status).toBe(400);
    const unknown = twoVariants(5, 40);
    (unknown.variants[1]!.conditions.items as unknown[]).push({ type: "moon_phase" });
    expect((await api(env, "POST", "/v1/tasks/task_lab_1/compare-policies", unknown)).status).toBe(400);
    const noeval = await api(env, "POST", "/v1/tasks/task_lab_noeval/compare-policies", twoVariants(5, 40));
    expect(noeval.status).toBe(409);
    expect(noeval.json["error"]).toBe("no_evaluation_yet");
    expect((await api(env, "POST", "/v1/tasks/task_lab_1/compare-policies", twoVariants(5, 40), {}, OTHER_API_KEY)).status).toBe(403);
  });
});

describe("L-03 / L-04 POST /v1/replays（无前视、缺口如实）", () => {
  const v1 = event("test:MACRO_TIER1:2026-09-18:cpi", 1, "2026-09-18T14:30:00.000Z", "2026-09-01T00:00:00.000Z");
  const v2 = event("test:MACRO_TIER1:2026-09-18:cpi", 2, "2026-09-18T15:30:00.000Z", "2026-09-18T15:05:00.000Z");
  const archive: ReplayArchive = {
    records: [quoteEvidence({ receivedAt: "2026-09-18T15:59:00.000Z", fromToken: FIXTURE_STABLE, toToken: FIXTURE_STOCK, id: "ev_q_rp" })],
    contextSnapshots: [{ receivedAt: "2026-09-18T13:00:00.000Z", context: ctx("2026-09-18T13:00:00.000Z", "18") }],
    eventVersions: [v1, v2],
    referenceBars: [],
    referencePurged: [{ from: "2026-09-18T17:00:00.000Z", to: "2026-09-18T18:00:00.000Z" }],
  };
  const conditions = { items: [{ type: "session", allow: ["US_REGULAR"] }, { type: "avoid_event_window", kinds: ["MACRO_TIER1"], beforeMin: 30, afterMin: 20, includeEstimated: true, wholeDayIfDayPrecision: true }] };
  it("201：15:00Z 只用 v1（放行）、15:10Z 才用 v2（阻塞）；REFERENCE_PURGED 如实；GET 同 id；他人 404；标 REPLAY", async () => {
    env = await createTestEnv({ now: NOW, labArchive: archive });
    const r = await api(env, "POST", "/v1/replays", { playbookId: "session_dca", assetKey: FIXTURE_STOCK_KEY, conditions, from: "2026-09-18T15:00:00.000Z", to: "2026-09-18T18:00:00.000Z", stepMinutes: 10 });
    expect(r.status).toBe(201);
    expect(r.json["mode"]).toBe("REPLAY");
    const run = r.json["run"] as { points: Array<{ t: string; outcome: string; knownAsOf: string; blockers: Array<{ code: string }> }>; gaps: Array<{ from: string; to: string; reason: string }>; coverage: Array<{ sources: string[] }> };
    const at = (t: string) => run.points.find((p) => p.t === t)!;
    expect(at("2026-09-18T15:00:00.000Z").outcome).toBe("SATISFIED");
    expect(at("2026-09-18T15:00:00.000Z").knownAsOf).toBe("2026-09-18T13:00:00.000Z");
    expect(at("2026-09-18T15:10:00.000Z").outcome).toBe("UNSATISFIED");
    expect(at("2026-09-18T15:10:00.000Z").blockers[0]!.code).toBe("EVENT_WINDOW_ACTIVE");
    for (const p of run.points) expect(p.knownAsOf <= p.t).toBe(true);
    expect(run.gaps.some((g) => g.reason === "REFERENCE_PURGED" && g.from === "2026-09-18T17:00:00.000Z")).toBe(true);
    expect(run.coverage.length).toBeGreaterThan(0);
    const id = r.json["replayId"] as string;
    expect(id).toMatch(/^rpl_/);
    const g = await api(env, "GET", `/v1/replays/${id}`);
    expect(g.status).toBe(200);
    expect(g.json["run"]).toEqual(run); // jsonb 回读键序会变，比对结构
    expect((await api(env, "GET", `/v1/replays/${id}`, undefined, {}, OTHER_API_KEY)).status).toBe(404);
  });
  it("校验：未来区间 / 未知资产 / 超 31 天 / 步长太小 → 400", async () => {
    env = await createTestEnv({ now: NOW, labArchive: archive });
    const base = { playbookId: "session_dca", assetKey: FIXTURE_STOCK_KEY, conditions, from: "2026-09-18T15:00:00.000Z", to: "2026-09-18T18:00:00.000Z" };
    expect((await api(env, "POST", "/v1/replays", { ...base, to: "2026-09-22T00:00:00.000Z" })).status).toBe(400);
    expect((await api(env, "POST", "/v1/replays", { ...base, assetKey: "eip155:196:0x0000000000000000000000000000000000000001" })).status).toBe(400);
    expect((await api(env, "POST", "/v1/replays", { ...base, from: "2026-08-01T00:00:00.000Z", to: "2026-09-18T00:00:00.000Z" })).status).toBe(400);
    expect((await api(env, "POST", "/v1/replays", { ...base, stepMinutes: 1 })).status).toBe(400);
    expect((await api(env, "POST", "/v1/replays", { ...base, playbookId: "yolo" })).status).toBe(400);
  });
  it("L-05 三个响应都没有收益类字段（黑名单扫描）", async () => {
    env = await createTestEnv({ now: NOW, labArchive: archive });
    env.labTasks.put(waitingTask());
    const a = await api(env, "GET", "/v1/tasks/task_lab_1/explain-wait");
    const b = await api(env, "POST", "/v1/tasks/task_lab_1/compare-policies", twoVariants(5, 40));
    const c = await api(env, "POST", "/v1/replays", { playbookId: "session_dca", assetKey: FIXTURE_STOCK_KEY, conditions, from: "2026-09-18T15:00:00.000Z", to: "2026-09-18T18:00:00.000Z" });
    expect([a.status, b.status, c.status]).toEqual([200, 201, 201]);
    expect(scanKeys(a.json)).toEqual([]);
    expect(scanKeys(b.json)).toEqual([]);
    expect(scanKeys(c.json)).toEqual([]);
  });
  it("开关 AGENT_C9_ENABLED=false → 三条路由 503 feature_disabled", async () => {
    env = await createTestEnv({ now: NOW, env: { AGENT_C9_ENABLED: "false" } });
    env.labTasks.put(waitingTask());
    expect((await api(env, "GET", "/v1/tasks/task_lab_1/explain-wait")).status).toBe(503);
    expect((await api(env, "POST", "/v1/tasks/task_lab_1/compare-policies", twoVariants(5, 40))).status).toBe(503);
    expect((await api(env, "POST", "/v1/replays", {})).status).toBe(503);
  });
});

describe("回放档案：三类数据源读取（DbReplayArchive）", () => {
  it("derivePurgedRanges：首末 bar 之间缺失的常规时段小时桶 → 清空区间；盘前/收盘后的缺失不算", () => {
    // 9/18（周五）：14:00Z(10ET) 有、15:00Z(11ET) 缺、16:00Z(12ET) 缺、17:00Z(13ET) 有、19:00Z(15ET) 有；18:00Z(14ET) 缺
    const bars = [
      { ts: "2026-09-18T14:00:00.000Z", refPriceUsd: 1, tokenPriceUsd: 1 },
      { ts: "2026-09-18T17:00:00.000Z", refPriceUsd: 1, tokenPriceUsd: 1 },
      { ts: "2026-09-18T19:00:00.000Z", refPriceUsd: 1, tokenPriceUsd: 1 },
    ];
    expect(derivePurgedRanges(bars)).toEqual([
      { from: "2026-09-18T15:00:00.000Z", to: "2026-09-18T17:00:00.000Z" },
      { from: "2026-09-18T18:00:00.000Z", to: "2026-09-18T19:00:00.000Z" },
    ]);
    // 跨周末：周五 19:00Z 到周一 14:00Z 之间没有常规时段小时桶 → 不算清空
    expect(derivePurgedRanges([bars[2]!, { ts: "2026-09-21T14:00:00.000Z", refPriceUsd: 1, tokenPriceUsd: 1 }])).toEqual([]);
    expect(derivePurgedRanges([])).toEqual([]);
  });
  it("verify_evidence 按资产过滤可见；premium_1h 只作背景并给出清空区间；verify_context_snapshots 缺表 → 来源为空、NO_ARCHIVE 如实", async () => {
    env = await createTestEnv({ now: NOW, labArchive: (db) => new DbReplayArchive(db) });
    const db = env.db;
    const evAt = new Date("2026-09-18T15:59:00.000Z");
    await db.insert(verifyEvidence).values([
      { evidenceId: "ev_db_q", jobId: "job_x", reportVersion: 1, record: quoteEvidence({ receivedAt: evAt.toISOString(), fromToken: FIXTURE_STABLE, toToken: FIXTURE_STOCK, id: "ev_db_q" }), rawRef: null, createdAt: evAt },
      { evidenceId: "ev_db_other", jobId: "job_y", reportVersion: 1, record: quoteEvidence({ receivedAt: evAt.toISOString(), fromToken: FIXTURE_STABLE, toToken: "0x3333333333333333333333333333333333333333", id: "ev_db_other" }), rawRef: null, createdAt: evAt },
    ]);
    const [asset] = await db.insert(assets).values({ symbol: "TESTx", underlying: "TEST", nameEn: "Test", nameCn: "测试", issuer: "test", issuerModel: "price_tracking", chain: "xlayer", address: FIXTURE_STOCK, decimals: 18 }).returning();
    await db.insert(premium1h).values([
      { assetId: asset!.id, ts: new Date("2026-09-18T14:00:00.000Z"), refPriceClose: 100, tokenPriceClose: 100.5, sampleN: 10 },
      { assetId: asset!.id, ts: new Date("2026-09-18T17:00:00.000Z"), refPriceClose: 101, tokenPriceClose: 101.2, sampleN: 10 },
    ]);
    const reader = new DbReplayArchive(db);
    const entry = env.service.registry.entries.find((e) => e.assetKey === FIXTURE_STOCK_KEY)!;
    const a = await reader.read({ entry, from: "2026-09-18T14:00:00.000Z", to: "2026-09-18T18:00:00.000Z" });
    expect(a.records.map((r) => r.evidenceId)).toEqual(["ev_db_q"]); // 另一资产的报价不可见
    expect(a.contextSnapshots).toEqual([]); // 表未到（迁移 0018）→ 空，不伪装
    expect(a.referenceBars.length).toBe(2);
    expect(a.referencePurged).toEqual([{ from: "2026-09-18T15:00:00.000Z", to: "2026-09-18T17:00:00.000Z" }]);
    // 走 HTTP：同一库
    const r = await api(env, "POST", "/v1/replays", { playbookId: "session_dca", assetKey: FIXTURE_STOCK_KEY, conditions: { items: [{ type: "session", allow: ["US_REGULAR"] }] }, from: "2026-09-18T14:00:00.000Z", to: "2026-09-18T17:00:00.000Z" });
    expect(r.status).toBe(201);
    const run = r.json["run"] as { gaps: Array<{ from: string; to: string; reason: string }>; coverage: Array<{ from: string; to: string; sources: string[] }>; points: Array<{ t: string; outcome: string }> };
    // 14:00 / 15:00：无证据无上下文 → NO_ARCHIVE；16:00：15:59 的报价可见（24h 回看）→ coverage verify_evidence
    expect(run.gaps.filter((g) => g.reason === "NO_ARCHIVE")).toEqual([{ from: "2026-09-18T14:00:00.000Z", to: "2026-09-18T16:00:00.000Z", reason: "NO_ARCHIVE" }]);
    expect(run.coverage).toEqual([{ from: "2026-09-18T16:00:00.000Z", to: "2026-09-18T17:00:00.000Z", sources: ["verify_evidence"] }]);
    // 参考价清空区间 15:00–17:00 落在回放区间内 → 如实输出（背景，不影响 quote）
    expect(run.gaps.filter((g) => g.reason === "REFERENCE_PURGED")).toEqual([{ from: "2026-09-18T15:00:00.000Z", to: "2026-09-18T17:00:00.000Z", reason: "REFERENCE_PURGED" }]);
    expect(run.points.find((p) => p.t === "2026-09-18T14:00:00.000Z")!.outcome).toBe("INSUFFICIENT_EVIDENCE");
    expect(run.points.find((p) => p.t === "2026-09-18T16:00:00.000Z")!.outcome).toBe("SATISFIED"); // session 条件 + 有档案
    expect(r.json["sources"]).toEqual({ verify_evidence: 1, verify_context_snapshots: 0, premium_1h: 2, events: 0 });
  });
});
