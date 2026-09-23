/** Lane D · 影响清单与六个动作（E-01 / E-03 / E-04 / E-05 / E-06 / E-07） */
import { afterEach, describe, expect, it } from "vitest";
import { fixtureRegistry, FIXTURE_STOCK_KEY } from "@chaconne/core/verify/fixtures";
import { IMPACT_ACTIONS } from "@chaconne/core/verify";
import { computeImpacts } from "../src/impacts/impacts";
import { postEarningsGate } from "../src/impacts/postEarningsWait";
import { reasonText } from "../src/impacts/reasonText";
import { fixtureHoldings, fixtureTasks, MemoryTaskCommands } from "../src/impacts/readers";
import { createLaneD } from "../src/events/earnings/wire";
import { MemoryEventStore, applyDraft } from "../src/events/earnings/store";
import { buildEarningsDraft } from "../src/events/earnings/mapping";
import { api, createTestEnv, type TestEnv, type TestEnvOptions } from "./helpers";
import { FAKE_UNDERLYING, FakeEarningsSource, NOW, OTHER_OWNER, OWNER, avoidTask, earningsTask, forbiddenKeys, macroEvent, row } from "./laneD.fixtures";

const registry = fixtureRegistry({ chainId: 196 });
const earningsEvent = (over: Parameters<typeof row>[0] = {}) => applyDraft(null, buildEarningsDraft(row(over), FAKE_UNDERLYING, NOW), NOW).event;

let env: TestEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

describe("E-01 财报事件命中标的 / 持仓 / 任务", () => {
  it("underlyingIds ↔ registry.underlyingId → 资产；持仓与任务都命中 → relation=user_rule、effect=wait、六动作", () => {
    const items = computeImpacts({
      owner: OWNER,
      nowIso: NOW,
      horizonHours: 48,
      events: [earningsEvent()],
      registry,
      holdings: { status: "ok", items: [{ assetKey: FIXTURE_STOCK_KEY, balanceRaw: "1000000" }] },
      tasks: { status: "ok", items: [earningsTask()] },
    });
    expect(items).toHaveLength(1);
    const it0 = items[0]!;
    expect(it0.relevance).toBe("holding_and_task");
    expect(it0.impact).toMatchObject({ eventId: "finnhub:EARNINGS:2026-10-28:FAKE", relation: "user_rule", assets: [FIXTURE_STOCK_KEY], holdings: [{ assetKey: FIXTURE_STOCK_KEY, balanceRaw: "1000000" }] });
    expect(it0.impact.tasks).toEqual([{ taskId: "task_e1", matchedRules: ["earnings_window(1,1)"], effect: "wait" }]);
    expect(it0.impact.actions).toEqual(["view_evidence", "create_watch_task", "keep_plan", "wait_by_rule", "pause_issuance", "preview_new_plan"]);
    expect(it0.rules[0]).toMatchObject({ taskId: "task_e1", upcoming: true, active: false, needsChoice: false, nextCheckAt: "2026-10-27T04:00:00.000Z" });
  });
  it("只有持仓无规则 → company_direct；无持仓无任务 → universe；不在 horizon → 不列；cancelled → 不列", () => {
    const holdings = fixtureHoldings({ [OWNER]: [{ assetKey: FIXTURE_STOCK_KEY, balanceRaw: "5" }] });
    const base = { owner: OWNER, nowIso: NOW, registry, tasks: { status: "ok" as const, items: [] } };
    return holdings.holdings(OWNER).then((h) => {
      const direct = computeImpacts({ ...base, horizonHours: 72, events: [earningsEvent()], holdings: h });
      expect(direct[0]!.impact.relation).toBe("company_direct");
      expect(direct[0]!.relevance).toBe("holding");
      expect(direct[0]!.impact.tasks).toEqual([]);
      const universe = computeImpacts({ ...base, horizonHours: 72, events: [earningsEvent()], holdings: { status: "unavailable", items: [] } });
      expect(universe[0]!.relevance).toBe("universe");
      expect(computeImpacts({ ...base, horizonHours: 24, events: [earningsEvent()], holdings: h })).toHaveLength(0);
      expect(computeImpacts({ ...base, horizonHours: 72, events: [{ ...earningsEvent(), status: "cancelled" }], holdings: h })).toHaveLength(0);
    });
  });
});

describe("E-04 宏观只标研究关联，文案不写涨跌", () => {
  it("MACRO_TIER1 → macro_research；有 avoid_event_window 规则的任务 effect=wait；任何文案不含涨/跌/up/down", () => {
    const items = computeImpacts({ owner: OWNER, nowIso: NOW, horizonHours: 72, events: [macroEvent()], registry, holdings: { status: "ok", items: [{ assetKey: FIXTURE_STOCK_KEY, balanceRaw: "1" }] }, tasks: { status: "ok", items: [avoidTask(true), earningsTask({ id: "task_no_rule", conditions: { items: [] } })] } });
    expect(items).toHaveLength(1);
    const m = items[0]!;
    expect(m.impact.relation).toBe("macro_research");
    expect(m.noteCode).toBe("MACRO_RESEARCH_ONLY");
    expect(m.impact.assets).toEqual([]);
    expect(m.impact.tasks).toEqual([{ taskId: "task_avoid_wholeday", matchedRules: ["avoid_event_window(EARNINGS|MACRO_TIER1,30,20)"], effect: "wait" }]);
    const text = JSON.stringify(m) + Object.values(["EARNINGS_WINDOW_ACTIVE", "EVENT_WINDOW_ACTIVE", "EVENT_DATE_UNCERTAIN", "EARNINGS_COVERAGE_UNKNOWN", "REFERENCE_STALE", "PRICE_IMPACT_EXCEEDED"]).flatMap((c) => [reasonText(c, "zh"), reasonText(c, "en")]).join(" ");
    expect(text).not.toMatch(/[涨跌]|\bup\b|\bdown\b|bullish|bearish|rally|plunge/i);
  });
});

describe("E-03 / E-05 / E-07 通过 HTTP", () => {
  const laneDWith = (o: { tasks?: ReturnType<typeof fixtureTasks>; commands?: MemoryTaskCommands; holdings?: ReturnType<typeof fixtureHoldings>; rows?: Record<string, never> | null; seedMacro?: boolean }) => (ctx: Parameters<NonNullable<TestEnvOptions["laneD"]>>[0]) => {
    const clock = () => new Date(NOW);
    const source = new FakeEarningsSource(o.rows === null ? {} : { FAKE: [row()] }, clock);
    const h = createLaneD({ ...ctx.cfg, AGENT_C6_STORE: "memory" }, ctx.db, ctx.registry, { source, clock, tasks: o.tasks, commands: o.commands, holdings: o.holdings })!;
    if (o.seedMacro) (h.store as MemoryEventStore).seed(macroEvent());
    return h;
  };

  it("E-03 未覆盖资产 → coverage unknown + EARNINGS_COVERAGE_UNKNOWN（不是空白、不是「无财报」）；公司行动 = not_connected", async () => {
    env = await createTestEnv({ now: NOW, laneD: laneDWith({ rows: null }) });
    await env.laneD!.ingestor!.ingestAll();
    const r = await api(env, "GET", `/v1/event-impacts?owner=${OWNER}&horizonHours=48`);
    expect(r.status).toBe(200);
    expect(r.json["coverage"]).toEqual([expect.objectContaining({ assetKey: FIXTURE_STOCK_KEY, underlyingId: FAKE_UNDERLYING, coverage: "unknown", code: "EARNINGS_COVERAGE_UNKNOWN", lastProbedAt: NOW })]);
    expect(r.json["corporateActions"]).toEqual({ status: "not_connected", note: "CORPORATE_ACTION_FEED_NOT_CONNECTED" });
    expect(r.json["holdings"]).toMatchObject({ status: "unavailable", note: "PORTFOLIO_SERVICE_NOT_READY" });
    expect(r.json["tasks"]).toMatchObject({ status: "unavailable", note: "TASKS_SERVICE_NOT_READY" });
    expect(r.json["impacts"]).toEqual([]);
    const cov = await api(env, "GET", "/v1/events/earnings/coverage");
    expect(cov.status).toBe(200);
    expect((cov.json["coverage"] as Array<{ state: string }>)[0]!.state).toBe("unknown");
  });

  it("owner 鉴权：地址绑定调用方只能查自己（403）；非绑定 key 无 owner → 400", async () => {
    env = await createTestEnv({ now: NOW, laneD: laneDWith({}), extraKeys: "vk_web:web*" });
    const mine = await api(env, "GET", `/v1/event-impacts?owner=${OWNER}`, undefined, { "x-verify-caller": OWNER }, "vk_web");
    expect(mine.status).toBe(200);
    expect(mine.json["owner"]).toBe(OWNER);
    const other = await api(env, "GET", `/v1/event-impacts?owner=${OTHER_OWNER}`, undefined, { "x-verify-caller": OWNER }, "vk_web");
    expect(other.status).toBe(403);
    const none = await api(env, "GET", "/v1/event-impacts");
    expect(none.status).toBe(400);
    const badH = await api(env, "GET", `/v1/event-impacts?owner=${OWNER}&horizonHours=-1`);
    expect(badH.status).toBe(400);
  });

  it("E-05 六个动作各自效果（任务服务就绪 fixture）+ E-07 不发任何执行", async () => {
    const tasks = [earningsTask(), avoidTask(false), earningsTask({ id: "task_free", mandateIds: [] })];
    const commands = new MemoryTaskCommands(tasks);
    env = await createTestEnv({ now: NOW, laneD: laneDWith({ tasks: fixtureTasks(tasks), commands, holdings: fixtureHoldings({ [OWNER]: [{ assetKey: FIXTURE_STOCK_KEY, balanceRaw: "7" }] }), seedMacro: true }) });
    await env.laneD!.ingestor!.ingestAll();
    const list = await api(env, "GET", `/v1/event-impacts?owner=${OWNER}&horizonHours=72`);
    expect(list.status).toBe(200);
    const impacts = list.json["impacts"] as Array<{ eventId: string; relation: string; actions: string[] }>;
    expect(impacts.map((i) => i.eventId)).toEqual(["finnhub:EARNINGS:2026-10-28:FAKE", "crowsnest:MACRO_TIER1:2026-10-28:cpi"]);
    expect(impacts[0]!.actions).toEqual([...IMPACT_ACTIONS]);
    const eventId = impacts[0]!.eventId;
    const act = (body: Record<string, unknown>) => api(env!, "POST", "/v1/event-impacts/actions", { owner: OWNER, eventId, ...body });

    // 1 view_evidence → 证据记录（market_event）
    const ve = await act({ action: "view_evidence" });
    expect(ve.status).toBe(200);
    expect(ve.json).toMatchObject({ effect: "evidence", executed: false, issuesExecution: false });
    expect((ve.json["evidence"] as Array<{ payload: { kind: string } }>)[0]!.payload.kind).toBe("market_event");
    // 2 create_watch_task：无 taskId → 建 SIMULATION 任务；有授权任务 → 草案（新授权）；无授权任务 → 直接挂条件
    const created = await act({ action: "create_watch_task" });
    expect(created.status).toBe(200);
    expect(created.json).toMatchObject({ effect: "created", mode: "SIMULATION", taskId: "task_fixture_1" });
    expect(commands.created[0]).toMatchObject({ mode: "SIMULATION", playbookId: "event_aware_accumulate", ownerAddress: OWNER });
    expect(commands.created[0]!.conditions.items.some((c) => c.type === "earnings_window")).toBe(true);
    const draft = await act({ action: "create_watch_task", taskId: "task_e1" });
    expect(draft.json).toMatchObject({ effect: "draft", draft: { taskId: "task_e1", requiresNewAuthorization: true, draftId: "draft_task_e1" } });
    const attached = await act({ action: "create_watch_task", taskId: "task_free" });
    expect(attached.json).toMatchObject({ effect: "attached", draft: { requiresNewAuthorization: false } });
    // 3 keep_plan → 无改动
    const kept = await act({ action: "keep_plan", taskId: "task_e1" });
    expect(kept.json).toMatchObject({ effect: "kept" });
    expect(commands.rechecks).toHaveLength(0);
    expect(commands.paused).toHaveLength(0);
    // 4 wait_by_rule → 按规则计算 nextCheckAt 并写回；day 精度未预选 → needs_choice（E-02 的选择提示）；带 wholeDayIfDayPrecision → 整日
    const wait = await act({ action: "wait_by_rule", taskId: "task_e1" });
    expect(wait.json).toMatchObject({ effect: "wait", nextCheckAt: "2026-10-27T04:00:00.000Z" });
    expect(commands.rechecks.at(-1)).toMatchObject({ taskId: "task_e1", nextCheckAt: "2026-10-27T04:00:00.000Z" });
    (env.laneD!.store as MemoryEventStore).seed(earningsEvent({ hour: "", date: "2026-10-27", quarter: 1 }));
    const dayId = "finnhub:EARNINGS:2026-10-27:FAKE";
    const choice = await api(env, "POST", "/v1/event-impacts/actions", { owner: OWNER, eventId: dayId, action: "wait_by_rule", taskId: "task_avoid_choice" });
    expect(choice.json).toMatchObject({ effect: "needs_choice", code: "EVENT_DATE_UNCERTAIN", nextCheckAt: null });
    expect((choice.json["blockers"] as Array<{ userActionRequired: boolean }>)[0]!.userActionRequired).toBe(true);
    const whole = await api(env, "POST", "/v1/event-impacts/actions", { owner: OWNER, eventId: dayId, action: "wait_by_rule", taskId: "task_avoid_choice", wholeDayIfDayPrecision: true });
    expect(whole.json).toMatchObject({ effect: "wait", nextCheckAt: "2026-10-27T04:00:00.000Z" });
    // 5 pause_issuance → 任务 PAUSED，说明只是停止签发
    const paused = await act({ action: "pause_issuance", taskId: "task_e1" });
    expect(paused.json).toMatchObject({ effect: "paused", taskStatus: "PAUSED" });
    expect(String((paused.json["message"] as { zh: string }).zh)).toContain("已取走且未过期的证书仍可能可执行");
    expect(commands.paused).toEqual(["task_e1"]);
    // 6 preview_new_plan → SIMULATION 预览，不写授权
    const prev = await act({ action: "preview_new_plan", taskId: "task_e1" });
    expect(prev.json).toMatchObject({ effect: "preview", mode: "SIMULATION", preview: { writesAuthorization: false } });
    expect((prev.json["preview"] as { diff: unknown[] }).diff).toHaveLength(1);
    // 宏观事件的 create_watch_task → avoid_event_window（整日预选）
    const macro = await api(env, "POST", "/v1/event-impacts/actions", { owner: OWNER, eventId: impacts[1]!.eventId, action: "create_watch_task" });
    expect(commands.created.at(-1)!.conditions.items.some((c) => c.type === "avoid_event_window" && c.kinds.includes("MACRO_TIER1") && c.wholeDayIfDayPrecision)).toBe(true);
    expect(macro.json["mode"]).toBe("SIMULATION");

    // E-07：所有响应 executed=false、issuesExecution=false，且不含任何执行材料键；命令层只收到 recheck / pause / create / attach，没有卖出或执行入口
    for (const r of [ve, created, draft, attached, kept, wait, choice, whole, paused, prev, macro]) {
      expect(r.json["executed"]).toBe(false);
      expect(r.json["issuesExecution"]).toBe(false);
      expect(forbiddenKeys(r.json)).toEqual([]);
    }
    expect(Object.keys(commands).sort()).toEqual(["attached", "created", "paused", "rechecks", "tasks"].sort());
    // 无效动作 / 无 eventId / 未知事件
    expect((await act({ action: "sell_now" })).status).toBe(400);
    expect((await api(env, "POST", "/v1/event-impacts/actions", { owner: OWNER, action: "keep_plan" })).status).toBe(400);
    expect((await api(env, "POST", "/v1/event-impacts/actions", { owner: OWNER, eventId: "nope", action: "keep_plan" })).status).toBe(400);
  });

  it("E-05 任务服务未就绪 → 503 not_ready（不假成功），草案仍返回给页面展示", async () => {
    env = await createTestEnv({ now: NOW, laneD: laneDWith({}) });
    await env.laneD!.ingestor!.ingestAll();
    const eventId = "finnhub:EARNINGS:2026-10-28:FAKE";
    const r = await api(env, "POST", "/v1/event-impacts/actions", { owner: OWNER, eventId, action: "create_watch_task" });
    expect(r.status).toBe(503);
    expect(r.json).toMatchObject({ effect: "not_ready", code: "TASKS_SERVICE_NOT_READY", executed: false, mode: "SIMULATION" });
    expect((r.json["draft"] as { mode: string }).mode).toBe("SIMULATION");
    const p = await api(env, "POST", "/v1/event-impacts/actions", { owner: OWNER, eventId, action: "pause_issuance", taskId: "task_e1" });
    expect(p.status).toBe(503);
    const w = await api(env, "POST", "/v1/event-impacts/actions", { owner: OWNER, eventId, action: "wait_by_rule", taskId: "task_e1" });
    expect(w.status).toBe(503);
    // 与 Lane B 无关的动作照常
    expect((await api(env, "POST", "/v1/event-impacts/actions", { owner: OWNER, eventId, action: "keep_plan" })).status).toBe(200);
    expect((await api(env, "POST", "/v1/event-impacts/actions", { owner: OWNER, eventId, action: "view_evidence" })).status).toBe(200);
    expect((await api(env, "POST", "/v1/event-impacts/actions", { owner: OWNER, eventId, action: "preview_new_plan" })).status).toBe(200);
    // 操作者摄入端点：地址绑定调用方 403
    env.setNow(NOW);
    const ing = await api(env, "POST", "/v1/events/earnings/ingest");
    expect(ing.status).toBe(200);
    expect((ing.json["runs"] as unknown[]).length).toBe(1);
  });

  it("开关 AGENT_C6_ENABLED=false → 路由不挂（404）", async () => {
    env = await createTestEnv({ now: NOW, env: { AGENT_C6_ENABLED: "false" }, laneD: (ctx) => createLaneD(ctx.cfg, ctx.db, ctx.registry) });
    expect(env.laneD).toBeNull();
    expect((await api(env, "GET", `/v1/event-impacts?owner=${OWNER}`)).status).toBe(404);
  });
});

describe("E-06 财报后计时结束但参考价未恢复 / 冲击过大 → 仍等待并说明两个原因", () => {
  const cond = { type: "earnings_window" as const, beforeTradingDays: 1, afterSessions: 1, requireRegularSessionAfter: true, requireLiveReferenceAfter: true };
  it("窗口内 → EARNINGS_WINDOW_ACTIVE；窗口后参考价陈旧 + 冲击超限 → 两个阻塞都列出并带文案；两者恢复 → SATISFIED", () => {
    const ev = earningsEvent();
    const inWindow = postEarningsGate({ event: ev, condition: cond, nowIso: "2026-10-29T15:00:00.000Z", session: "REGULAR", reference: { status: "live", observedAt: "2026-10-29T14:59:00.000Z" }, quote: { status: "ok", priceImpactBps: 10 }, maxPriceImpactBps: 100 });
    expect(inWindow).toMatchObject({ outcome: "UNSATISFIED", windowEnded: false, windowEndUtc: "2026-10-29T20:00:00.000Z", nextCheckAt: "2026-10-29T20:00:00.000Z" });
    expect(inWindow.blockers.map((b) => b.code)).toEqual(["EARNINGS_WINDOW_ACTIVE"]);
    const after = postEarningsGate({ event: ev, condition: cond, nowIso: "2026-10-30T15:00:00.000Z", session: "REGULAR", reference: { status: "stale", observedAt: "2026-10-29T20:00:00.000Z", evidenceId: "ev_ref" }, quote: { status: "ok", priceImpactBps: 250, evidenceId: "ev_q" }, maxPriceImpactBps: 100 });
    expect(after.windowEnded).toBe(true);
    expect(after.outcome).toBe("UNSATISFIED");
    expect(after.blockers.map((b) => b.code)).toEqual(["REFERENCE_STALE", "PRICE_IMPACT_EXCEEDED"]);
    expect(after.blockers[0]!.text).toBe(reasonText("REFERENCE_STALE", "zh"));
    expect(after.blockers[0]!.text).toContain("参考价尚未恢复");
    expect(after.blockers[1]!.text).toContain("价格冲击超过");
    expect(after.blockers[0]!.evidenceIds).toEqual(["ev_ref"]);
    const missing = postEarningsGate({ event: ev, condition: cond, nowIso: "2026-10-30T15:00:00.000Z", session: "REGULAR", reference: { status: "missing", observedAt: null }, quote: { status: "ok", priceImpactBps: null }, maxPriceImpactBps: 100 });
    expect(missing.outcome).toBe("INSUFFICIENT_EVIDENCE");
    expect(missing.blockers.map((b) => b.code)).toEqual(["REFERENCE_MISSING", "PRICE_IMPACT_UNKNOWN"]);
    const outside = postEarningsGate({ event: ev, condition: cond, nowIso: "2026-10-30T22:00:00.000Z", session: "POST", reference: { status: "live", observedAt: null }, quote: { status: "ok", priceImpactBps: 5 }, maxPriceImpactBps: 100 });
    expect(outside.blockers.map((b) => b.code)).toEqual(["MARKET_OUTSIDE_REGULAR"]);
    const ok = postEarningsGate({ event: ev, condition: cond, nowIso: "2026-10-30T15:00:00.000Z", session: "REGULAR", reference: { status: "live", observedAt: "2026-10-30T14:59:50.000Z" }, quote: { status: "ok", priceImpactBps: 20 }, maxPriceImpactBps: 100 });
    expect(ok).toMatchObject({ outcome: "SATISFIED", blockers: [] });
  });
});
