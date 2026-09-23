/** Lane D · 财报层摄入 / 事件存储 / 修订传播（E-02）与时间映射 */
import { afterEach, describe, expect, it } from "vitest";
import { MemoryEventStore, MemoryEvidenceSink, DrizzleEventStore, DrizzleEvidenceSink, applyDraft } from "../src/events/earnings/store";
import { buildEarningsDraft, earningsEventId, nyLocalToUtc, regularSessionBounds, sessionHintOf } from "../src/events/earnings/mapping";
import { addTradingDays, avoidEventWindow, earningsWindow, evaluateRule, matchRules } from "../src/events/earnings/window";
import { EarningsIngestor } from "../src/events/earnings/ingest";
import { EventRevisionPropagator } from "../src/events/earnings/propagate";
import { parseEarningsCalendar } from "../src/events/earnings/finnhubEarnings";
import { fixtureTasks, MemoryNotifier, MemoryTaskCommands, notReadyCommands, notReadyTasks } from "../src/impacts/readers";
import { fixtureRegistry } from "@chaconne/core/verify/fixtures";
import { FAKE_UNDERLYING, FakeEarningsSource, NOW, avoidTask, earningsTask, forbiddenKeys, row } from "./laneD.fixtures";
import { ensureLaneDTables } from "./laneDDdl";
import { testDb } from "./helpers";

const registry = fixtureRegistry({ chainId: 196 });
let closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of closers) await c();
  closers = [];
});

describe("时间映射（纽约时区，不硬编码偏移）", () => {
  it("bmo/amc 锚定常规时段边界；夏令时与冬令时都对；半日市 13:00", () => {
    expect(nyLocalToUtc("2026-10-28", 9, 30)).toBe("2026-10-28T13:30:00.000Z"); // EDT −4
    expect(nyLocalToUtc("2026-12-15", 16, 0)).toBe("2026-12-15T21:00:00.000Z"); // EST −5
    expect(regularSessionBounds("2026-11-27").close).toBe("2026-11-27T18:00:00.000Z"); // 感恩节次日 13:00 EST
    expect(sessionHintOf("BMO")).toBe("bmo");
    expect(sessionHintOf("")).toBeNull();
  });
  it("交易日加减跨周末与假日（2026-11-26 感恩节）", () => {
    expect(addTradingDays("2026-11-25", 1)).toBe("2026-11-27");
    expect(addTradingDays("2026-11-30", -1)).toBe("2026-11-27");
    expect(addTradingDays("2026-10-31", 0)).toBe("2026-11-02"); // 周六 → 下周一
  });
  it("行 → MarketEvent：id 形态、exact/day、estimated、firstKnownAt=首次入库", () => {
    const d = buildEarningsDraft(row(), FAKE_UNDERLYING, NOW);
    const r = applyDraft(null, d, NOW);
    expect(r.event.id).toBe(earningsEventId("2026-10-28", "FAKE"));
    expect(r.event.id).toBe("finnhub:EARNINGS:2026-10-28:FAKE");
    expect(r.event).toMatchObject({ kind: "EARNINGS", datePrecision: "exact", sessionHint: "amc", scheduledAtUtc: "2026-10-28T20:00:00.000Z", status: "estimated", revision: 1, firstKnownAt: NOW, tz: "America/New_York", underlyingIds: [FAKE_UNDERLYING] });
    const day = applyDraft(null, buildEarningsDraft(row({ hour: "" }), FAKE_UNDERLYING, NOW), NOW);
    expect(day.event.datePrecision).toBe("day");
    expect(day.event.scheduledAtUtc).toBeNull();
    const dmh = applyDraft(null, buildEarningsDraft(row({ hour: "dmh" }), FAKE_UNDERLYING, NOW), NOW);
    expect(dmh.event.datePrecision).toBe("day");
    expect(dmh.event.sessionHint).toBe("dmh");
  });
  it("解析：非 200 / 非数组 → null（不伪造空日历）", () => {
    expect(parseEarningsCalendar('{"earningsCalendar":[]}', 403)).toBeNull();
    expect(parseEarningsCalendar("not json", 200)).toBeNull();
    expect(parseEarningsCalendar('{"earningsCalendar":[{"date":"2026-10-28","hour":"amc","quarter":4,"year":2026,"symbol":"FAKE"}]}', 200)).toHaveLength(1);
  });
});

describe("修订规则（§11.2）", () => {
  it("改期不换 id：revision+1、revisedFrom、status=revised、firstKnownAt 不变；只变 sourceFetchedAt 不算修订；actual 出现 → released", () => {
    const first = applyDraft(null, buildEarningsDraft(row(), FAKE_UNDERLYING, NOW), NOW);
    const later = "2026-10-27T14:00:00.000Z";
    const same = applyDraft(first.event, buildEarningsDraft(row(), FAKE_UNDERLYING, later), later);
    expect(same.change).toBe("unchanged");
    expect(same.event.revision).toBe(1);
    expect(same.event.sourceFetchedAt).toBe(later);
    const moved = applyDraft(first.event, buildEarningsDraft(row({ date: "2026-10-29" }), FAKE_UNDERLYING, later), later);
    expect(moved.change).toBe("revised");
    expect(moved.event.id).toBe(first.event.id);
    expect(moved.event.revision).toBe(2);
    expect(moved.event.revisedFrom).toEqual({ scheduledAtUtc: "2026-10-28T20:00:00.000Z", dateLocal: "2026-10-28" });
    expect(moved.event.status).toBe("revised");
    expect(moved.event.firstKnownAt).toBe(NOW);
    expect(moved.event.dateLocal).toBe("2026-10-29");
    const rel = applyDraft(moved.event, buildEarningsDraft(row({ date: "2026-10-29", epsActual: 1.3 }), FAKE_UNDERLYING, "2026-10-30T00:00:00.000Z"), "2026-10-30T00:00:00.000Z");
    expect(rel.change).toBe("released");
    expect(rel.event.status).toBe("released");
    expect(rel.event.releasedAt).toBe("2026-10-30T00:00:00.000Z");
    expect(rel.event.revision).toBe(3);
  });
});

describe("窗口（不由 producer 决定；按任务条件参数）", () => {
  const ev = applyDraft(null, buildEarningsDraft(row(), FAKE_UNDERLYING, NOW), NOW).event;
  it("earnings_window(1,1)：amc → 前一交易日 00:00 ET 起，到次日常规收盘止；bmo 当日算第 1 个时段", () => {
    const w = earningsWindow(ev, { type: "earnings_window", beforeTradingDays: 1, afterSessions: 1, requireRegularSessionAfter: true, requireLiveReferenceAfter: true });
    expect(w).toEqual({ startUtc: "2026-10-27T04:00:00.000Z", endUtc: "2026-10-29T20:00:00.000Z", basis: "trading_sessions" });
    const bmo = applyDraft(null, buildEarningsDraft(row({ hour: "bmo" }), FAKE_UNDERLYING, NOW), NOW).event;
    expect(earningsWindow(bmo, { type: "earnings_window", beforeTradingDays: 1, afterSessions: 1, requireRegularSessionAfter: true, requireLiveReferenceAfter: true }).endUtc).toBe("2026-10-28T20:00:00.000Z");
  });
  it("avoid_event_window：exact → ±分钟；day 且预选整日 → 整个纽约本地日；未预选 → EVENT_DATE_UNCERTAIN 不补时刻", () => {
    const c = { type: "avoid_event_window" as const, kinds: ["EARNINGS" as const], beforeMin: 30, afterMin: 20, includeEstimated: true, wholeDayIfDayPrecision: false };
    expect(avoidEventWindow(ev, c)).toEqual({ ok: true, window: { startUtc: "2026-10-28T19:30:00.000Z", endUtc: "2026-10-28T20:20:00.000Z", basis: "exact" } });
    const day = applyDraft(null, buildEarningsDraft(row({ hour: "" }), FAKE_UNDERLYING, NOW), NOW).event;
    expect(avoidEventWindow(day, c)).toEqual({ ok: false, code: "EVENT_DATE_UNCERTAIN", userActionRequired: true });
    expect(avoidEventWindow(day, { ...c, wholeDayIfDayPrecision: true })).toEqual({ ok: true, window: { startUtc: "2026-10-28T04:00:00.000Z", endUtc: "2026-10-29T04:00:00.000Z", basis: "whole_day" } });
    // includeEstimated=false → estimated 事件不匹配
    expect(matchRules(ev, [{ ...c, includeEstimated: false }])).toHaveLength(0);
    const m = matchRules(day, [c])[0]!;
    const r = evaluateRule(day, m, "2026-10-28T15:00:00.000Z");
    expect(r.active).toBe(true);
    expect(r.blocker?.code).toBe("EVENT_DATE_UNCERTAIN");
    expect(r.blocker?.userActionRequired).toBe(true);
    expect(r.nextCheckAt).toBeNull();
  });
});

describe("摄入（假源）与 E-02 修订传播", () => {
  it("每次摄入落 market_event 证据；0 行 → coverage unknown；上游 4xx → unavailable 且不伪造事件", async () => {
    const clock = () => new Date(NOW);
    const store = new MemoryEventStore();
    const evidence = new MemoryEvidenceSink();
    const source = new FakeEarningsSource({ FAKE: [row()] }, clock);
    const ing = new EarningsIngestor({ source, registry, store, evidence, clock, spacingMs: 0 });
    const s = await ing.ingestAll();
    expect(s.created).toBe(1);
    expect(source.calls).toEqual(["FAKE"]);
    expect(ing.range(new Date(NOW))).toEqual({ from: "2026-10-19", to: "2027-02-23" });
    const ev = (await store.list())[0]!;
    expect(evidence.records).toHaveLength(1);
    expect(evidence.records[0]!.record.payload).toMatchObject({ kind: "market_event", eventId: ev.id, revision: 1, status: "estimated", datePrecision: "exact", firstKnownAt: NOW });
    expect(evidence.records[0]!.record.time.sourceTimeKind).toBe("not_provided");
    expect((await store.coverage([FAKE_UNDERLYING]))[0]!.state).toBe("covered");
    source.rows = { FAKE: [] };
    await ing.ingestAll();
    expect((await store.coverage([FAKE_UNDERLYING]))[0]!.state).toBe("unknown");
    source.rows = { FAKE: { status: 429 } };
    const s3 = await ing.ingestAll();
    expect(s3.errors).toBe(1);
    expect((await store.coverage([FAKE_UNDERLYING]))[0]!.state).toBe("unavailable");
    expect(await store.list()).toHaveLength(1);
    expect((await store.coverage(["us-equity:NOPE"]))[0]!.state).toBe("not_probed");
  });

  it("E-02 改期传播与 event.revised：revision 变化 → 受影响任务 nextCheckAt/阻塞重算 → 通知（幂等键）；未预选整日的 day 精度 → 需要选择", async () => {
    let now = NOW;
    const clock = () => new Date(now);
    const store = new MemoryEventStore();
    const evidence = new MemoryEvidenceSink();
    const tasks = [earningsTask(), avoidTask(false), avoidTask(true)];
    const commands = new MemoryTaskCommands(tasks);
    const notify = new MemoryNotifier();
    const propagator = new EventRevisionPropagator({ tasks: fixtureTasks(tasks), commands, notify, clock });
    const source = new FakeEarningsSource({ FAKE: [row()] }, clock);
    const ing = new EarningsIngestor({ source, registry, store, evidence, clock, spacingMs: 0, onChange: (r) => propagator.onChange(r).then(() => undefined) });
    await ing.ingestAll();
    expect(notify.sent).toHaveLength(0); // 首次创建不是修订
    expect(commands.rechecks).toHaveLength(0);

    // 改期 10-28 amc → 10-29（无 hour → day 精度）
    now = "2026-10-27T14:00:00.000Z";
    source.rows = { FAKE: [row({ date: "2026-10-29", hour: "" })] };
    await ing.ingestAll();
    const ev = (await store.list())[0]!;
    expect(ev.revision).toBe(2);
    expect(ev.datePrecision).toBe("day");
    expect(notify.sent).toHaveLength(1);
    expect(notify.sent[0]).toMatchObject({ type: "event.revised", entityId: ev.id, version: 2, idempotencyKey: `event.revised:${ev.id}:2` });
    expect(notify.sent[0]!.url).toContain(`/agent/events?event=${encodeURIComponent(ev.id)}`);
    expect(forbiddenKeys(notify.sent)).toEqual([]);
    // 重复入队同一幂等键不重复
    await notify.enqueue(notify.sent[0]!);
    expect(notify.sent).toHaveLength(1);
    // 三个任务都被重算
    const byTask = new Map(commands.rechecks.map((r) => [r.taskId, r]));
    // earnings_window(1,1)：day 精度按保守（下一交易日为第 1 个时段）→ 窗口 10-28 00:00 ET ~ 10-30 收盘；now 在窗口内 → 阻塞 + nextCheckAt=窗口结束
    expect(byTask.get("task_e1")).toMatchObject({ nextCheckAt: "2026-10-28T04:00:00.000Z", blockers: [] });
    // 未预选整日：不补时刻 → nextCheckAt null，阻塞 EVENT_DATE_UNCERTAIN（要求用户选择）
    expect(byTask.get("task_avoid_choice")!.nextCheckAt).toBeNull();
    expect(byTask.get("task_avoid_choice")!.blockers[0]).toMatchObject({ code: "EVENT_DATE_UNCERTAIN", userActionRequired: true, nextCheckAt: null });
    // 预选整日：整日等待 → nextCheckAt = 10-29 00:00 ET（窗口开始）
    expect(byTask.get("task_avoid_wholeday")).toMatchObject({ nextCheckAt: "2026-10-29T04:00:00.000Z", blockers: [] });
    // 修订历史
    const revs = await store.revisions(ev.id);
    expect(revs.map((r) => r.revision)).toEqual([1, 2]);
    expect(revs[1]!.changedFields).toEqual(expect.arrayContaining(["dateLocal", "scheduledAtUtc", "sessionHint", "datePrecision"]));

    // 再次摄入同一内容：不修订、不重复通知
    await ing.ingestAll();
    expect((await store.list())[0]!.revision).toBe(2);
    expect(notify.sent).toHaveLength(1);
  });

  it("任务服务未就绪：仍发通知，但标记未能应用（不伪装已重算）", async () => {
    const clock = () => new Date(NOW);
    const notify = new MemoryNotifier();
    const propagator = new EventRevisionPropagator({ tasks: notReadyTasks, commands: notReadyCommands, notify, clock });
    const first = applyDraft(null, buildEarningsDraft(row(), FAKE_UNDERLYING, NOW), NOW);
    const moved = applyDraft(first.event, buildEarningsDraft(row({ date: "2026-10-29" }), FAKE_UNDERLYING, NOW), NOW);
    const r = await propagator.onChange(moved);
    expect(r).toMatchObject({ notified: true, type: "event.revised", tasksStatus: "unavailable", tasks: [] });
    expect(notify.sent).toHaveLength(1);
  });

  it("Drizzle 存储：upsert / 修订 / 摄入记录 / 覆盖 / 证据 与内存实现同义", async () => {
    const { db, close } = await testDb();
    closers.push(close);
    await ensureLaneDTables(db);
    const store = new DrizzleEventStore(db);
    const sink = new DrizzleEvidenceSink(db);
    const clock = () => new Date(NOW);
    const source = new FakeEarningsSource({ FAKE: [row()] }, clock);
    const ing = new EarningsIngestor({ source, registry, store, evidence: sink, clock, spacingMs: 0 });
    await ing.ingestAll();
    const ev = (await store.list({ kinds: ["EARNINGS"], underlyingIds: [FAKE_UNDERLYING] }))[0]!;
    expect(ev.id).toBe("finnhub:EARNINGS:2026-10-28:FAKE");
    expect(await store.get(ev.id)).toEqual(ev);
    source.rows = { FAKE: [row({ date: "2026-10-29" })] };
    await ing.ingestAll();
    const moved = (await store.get(ev.id))!;
    expect(moved.revision).toBe(2);
    expect(moved.revisedFrom?.dateLocal).toBe("2026-10-28");
    expect((await store.revisions(ev.id)).map((r) => r.revision)).toEqual([1, 2]);
    expect(await store.list({ fromDate: "2026-10-29", toDate: "2026-10-29" })).toHaveLength(1);
    expect(await store.list({ fromDate: "2026-11-01" })).toHaveLength(0);
    const cov = await store.coverage([FAKE_UNDERLYING, "us-equity:NOPE"]);
    expect(cov.map((c) => c.state)).toEqual(["covered", "not_probed"]);
    const evs = await sink.forRef(ev.id);
    expect(evs).toHaveLength(2);
    expect(evs.map((e) => (e.payload as { revision: number }).revision).sort()).toEqual([1, 2]);
  });
});
