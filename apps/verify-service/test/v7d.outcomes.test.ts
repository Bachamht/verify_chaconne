/** v7 Lane D · D2 事件实际值摄入：D-02 / D-03 / D-08（crowsnest 路径）、D-06（财报回放）、/v1/events 开关视图 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { verifyEvents } from "@chaconne/db";
import { fixtureRegistry } from "@chaconne/core/verify/fixtures";
import type { MarketEvent, MarketEventV7, NotificationPayload } from "@chaconne/core/verify";
import { EventStore } from "../src/events/store";
import { CrowsnestAdapter } from "../src/context/crowsnest";
import { parseKeyring } from "../src/context/keys";
import { EventRevisionPropagator } from "../src/events/earnings/propagate";
import { applyDraft, DrizzleEventStore, MemoryEventStore, MemoryEvidenceSink } from "../src/events/earnings/store";
import { buildEarningsDraft, buildEarningsOutcome, decimalFromNumber } from "../src/events/earnings/mapping";
import { parseEarningsCalendar } from "../src/events/earnings/finnhubEarnings";
import { EarningsIngestor } from "../src/events/earnings/ingest";
import { OutcomeHookRegistry, type OutcomeHookInfo } from "../src/events/outcomes";
import { notReadyCommands, notReadyTasks, type Notifier } from "../src/impacts/readers";
import { api, createTestEnv, testDb, type TestEnv } from "./helpers";
import { signedContext, testKeypair } from "./contextHelpers";
import { FAKE_UNDERLYING, FakeEarningsSource, NOW, row } from "./laneD.fixtures";

const FIX = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "packages", "core", "src", "verify", "__fixtures__", "v7", "nfp-2026-10-02", "FIXTURE_nfp_outcome_event.json"), "utf8")) as { scheduled: MarketEventV7; arrived: MarketEventV7; corrected: MarketEventV7 };
const ID = FIX.scheduled.id;
const T_SCHED = new Date("2026-10-02T12:00:30.000Z");
const T_ARRIVE = new Date("2026-10-02T12:30:45.000Z");
const T_CORRECT = new Date("2026-10-02T12:45:10.000Z");

let closers: Array<() => Promise<void>> = [];
let env: TestEnv | null = null;
afterEach(async () => {
  for (const c of closers) await c();
  closers = [];
  await env?.close();
  env = null;
});

/** 原样计数（不去重）——证明「恰一次」不是靠下游幂等掩盖的 */
class CountingNotifier implements Notifier {
  readonly sent: NotificationPayload[] = [];
  async enqueue(p: NotificationPayload): Promise<void> {
    this.sent.push(p);
  }
}

async function store(outcomes: boolean, now = T_CORRECT) {
  const t = await testDb();
  closers.push(t.close);
  const events = new EventStore(t.db, { outcomes, now: () => now });
  const hooks: OutcomeHookInfo[] = [];
  events.outcomeHooks.set({ onDataArrived: (_id, info) => void hooks.push(info), onOutcomeRevised: (_id, info) => void hooks.push(info) });
  const rowOf = async () => (await t.db.select().from(verifyEvents).where(eq(verifyEvents.id, ID)).limit(1))[0]!;
  return { db: t.db, events, hooks, rowOf };
}

describe("D-08 / D-02 / D-03 · EventStore 实际值摄入（开关开）", () => {
  it("D-08 revision 不变的更新带 outcome → 整条丢弃（outcome 不入库、无回调）；revision+1 → data_arrived（不是 revised/released），恰一次", async () => {
    const s = await store(true);
    const r0 = await s.events.upsert([FIX.scheduled], T_SCHED);
    expect(r0.changes[0]!.change).toBe("created");
    // producer 忘了 revision+1：同 revision 附上 outcome → 被当作旧修订丢弃
    const sameRev = { ...FIX.arrived, revision: FIX.scheduled.revision };
    const rDrop = await s.events.upsert([sameRev], T_ARRIVE);
    expect(rDrop.unchanged).toEqual([ID]);
    expect(rDrop.changes).toEqual([]);
    expect(s.hooks).toEqual([]);
    const afterDrop = await s.rowOf();
    expect(afterDrop.outcomeJson).toBeNull();
    expect(afterDrop.outcomeReceivedAt).toBeNull();
    expect(((await s.events.byId(ID)) as MarketEventV7).dataStatus).toBe("due_pending_data");

    // 正确做法：revision + 1
    const r1 = await s.events.upsert([FIX.arrived], T_ARRIVE);
    expect(r1.changes).toHaveLength(1);
    expect(r1.changes[0]).toMatchObject({ change: "data_arrived", outcomeRevision: 0 });
    expect(r1.changes[0]!.changedFields).toContain("outcome");
    expect(s.hooks).toEqual([{ eventId: ID, revision: 4, outcomeRevision: 0, change: "data_arrived", receivedAt: T_ARRIVE.toISOString(), provider: "crowsnest" }]);
    const row = await s.rowOf();
    expect(row.outcomeRevision).toBe(0);
    expect(row.outcomeHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(row.outcomeReceivedAt?.toISOString()).toBe(T_ARRIVE.toISOString());
    const view = (await s.events.byId(ID)) as MarketEventV7;
    expect(view).toMatchObject({ outcomeRevision: 0, dataStatus: "data_arrived" });
    expect(view.outcome?.metrics.map((m) => m.key)).toEqual(["payrolls_change", "unemployment_rate", "ahe_mom"]);

    // 同一修订重投 → unchanged，不再回调
    await s.events.upsert([FIX.arrived], new Date(T_ARRIVE.getTime() + 60_000));
    expect(s.hooks).toHaveLength(1);
  });

  it("D-03 outcome 再变（revision+1）→ revised、outcome_revision+1、onOutcomeRevised；仅 fetchedAt 变 → outcome_revision 不变", async () => {
    const s = await store(true);
    await s.events.upsert([FIX.scheduled], T_SCHED);
    await s.events.upsert([FIX.arrived], T_ARRIVE);
    // 只重抓（fetchedAt 变、内容不变）
    const refetch = { ...FIX.arrived, revision: 5, outcome: { ...FIX.arrived.outcome!, fetchedAt: "2026-10-02T12:40:00.000Z" } };
    const rSame = await s.events.upsert([refetch], new Date("2026-10-02T12:40:05.000Z"));
    expect(rSame.changes[0]!.change).not.toBe("data_arrived");
    expect(rSame.changes[0]!.changedFields).not.toContain("outcome");
    expect((await s.rowOf()).outcomeRevision).toBe(0);
    expect((await s.rowOf()).outcomeReceivedAt?.toISOString()).toBe(T_ARRIVE.toISOString());

    const corrected = { ...FIX.corrected, revision: 6 };
    const r2 = await s.events.upsert([corrected], T_CORRECT);
    expect(r2.changes[0]).toMatchObject({ change: "revised", outcomeRevision: 1 });
    expect(r2.changes[0]!.changedFields).toEqual(["outcome"]);
    expect(s.hooks.map((h) => [h.change, h.outcomeRevision])).toEqual([
      ["data_arrived", 0],
      ["revised", 1],
    ]);
    const row = await s.rowOf();
    expect(row.outcomeRevision).toBe(1);
    expect(row.outcomeReceivedAt?.toISOString()).toBe(T_CORRECT.toISOString());
    expect(((await s.events.byId(ID)) as MarketEventV7).dataStatus).toBe("revised");

    // 修订史：每条带当时的 outcome / outcomeRevision / dataStatus
    const revs = await s.events.revisions(ID);
    expect(revs.map((r) => [r.revision, (r.event as MarketEventV7).outcomeRevision ?? null, (r.event as MarketEventV7).dataStatus])).toEqual([
      [3, null, "upcoming"],
      [4, 0, "data_arrived"],
      [5, 0, "data_arrived"],
      [6, 1, "revised"],
    ]);
    // 回放无前视：到达之前的 asOf 看不到 outcome
    const before = (await s.events.listKnownAsOf(new Date("2026-10-02T12:30:10.000Z"))) as MarketEventV7[];
    expect(before[0]).toMatchObject({ revision: 3, dataStatus: "due_pending_data" });
    expect(before[0]!.outcome).toBeUndefined();
    const mid = (await s.events.listKnownAsOf(new Date("2026-10-02T12:31:00.000Z"))) as MarketEventV7[];
    expect(mid[0]).toMatchObject({ revision: 4, outcomeRevision: 0, dataStatus: "data_arrived" });
  });

  it("后续修订不带 outcome：沿用已入库的（实际值不会消失）；emitHooks=false（回填快照）不回调", async () => {
    const s = await store(true);
    await s.events.upsert([FIX.scheduled], T_SCHED);
    await s.events.upsert([FIX.arrived], T_ARRIVE, { emitHooks: false });
    expect(s.hooks).toEqual([]);
    const { outcome: _o, ...noOutcome } = FIX.arrived;
    void _o;
    await s.events.upsert([{ ...noOutcome, revision: 5 }], T_CORRECT);
    const v = (await s.events.byId(ID)) as MarketEventV7;
    expect(v).toMatchObject({ revision: 5, outcomeRevision: 0, dataStatus: "data_arrived" });
    expect(v.outcome).toBeDefined();
  });

  it("producer 给的 outcomeRevision / dataStatus 不被采信", async () => {
    const s = await store(true);
    await s.events.upsert([{ ...FIX.arrived, outcomeRevision: 9, dataStatus: "revised" }], T_ARRIVE);
    expect(((await s.events.byId(ID)) as MarketEventV7).outcomeRevision).toBe(0);
  });
});

describe("开关关：分类 / 读口与 v6 一致；outcome 列照写（供时延测量）", () => {
  it("附上 outcome 的发布 → 旧分类 released，无回调；读口没有 outcome / outcomeRevision / dataStatus", async () => {
    const s = await store(false);
    await s.events.upsert([FIX.scheduled], T_SCHED);
    const r = await s.events.upsert([FIX.arrived], T_ARRIVE);
    expect(r.changes[0]!.change).toBe("released");
    expect(r.changes[0]!.changedFields).not.toContain("outcome");
    expect(r.changes[0]!.event).not.toHaveProperty("outcome");
    expect(s.hooks).toEqual([]);
    for (const ev of [await s.events.byId(ID), ...(await s.events.list()), ...(await s.events.revisions(ID)).map((x) => x.event), ...(await s.events.listKnownAsOf(T_CORRECT))]) {
      expect(ev).not.toHaveProperty("outcome");
      expect(ev).not.toHaveProperty("outcomeRevision");
      expect(ev).not.toHaveProperty("dataStatus");
    }
    expect((await s.rowOf()).outcomeReceivedAt?.toISOString()).toBe(T_ARRIVE.toISOString());
  });
});

describe("D-02 crowsnest 摄入 → 修订传播：event.data_arrived 恰一次、不发 event.revised", () => {
  it("签名快照：scheduled → arrived(rev+1) → 重投 → corrected(rev+1)", async () => {
    const t = await testDb();
    closers.push(t.close);
    const kp = testKeypair();
    let now = T_SCHED;
    const events = new EventStore(t.db, { outcomes: true, now: () => now });
    const hooked: string[] = [];
    events.outcomeHooks.set({ onDataArrived: (id) => void hooked.push(id) });
    const crowsnest = new CrowsnestAdapter({ db: t.db, events, keyring: parseKeyring(`${kp.publicKeyId}=${kp.publicKeyHex}`), now: () => now });
    const notifier = new CountingNotifier();
    const propagator = new EventRevisionPropagator({ tasks: notReadyTasks, commands: notReadyCommands, notify: notifier, clock: () => now, publicBaseUrl: "http://test" });
    crowsnest.setEventChangeSink((r) => propagator.onChange(r));
    const ingest = async (ev: MarketEvent, at: Date) => {
      now = at;
      const r = await crowsnest.ingest(signedContext(kp, { at: at.toISOString(), events: [ev] }), { endpoint: "test", mode: "LIVE" });
      expect(r.ok).toBe(true);
    };
    await ingest(FIX.scheduled, T_SCHED);
    await ingest(FIX.arrived, T_ARRIVE);
    await ingest(FIX.arrived, new Date(T_ARRIVE.getTime() + 60_000));
    expect(notifier.sent.map((n) => n.type)).toEqual(["event.data_arrived"]);
    expect(notifier.sent[0]).toMatchObject({ entityId: ID, version: 4, idempotencyKey: `event.data_arrived:${ID}:4` });
    expect(notifier.sent[0]!.summary).toBe("Employment Situation (FIXTURE): actual values received (rev 4)");
    // 载荷不带数值（通知只是唤醒）
    expect(JSON.stringify(notifier.sent[0])).not.toMatch(/111|4\.4/);
    expect(hooked).toEqual([ID]);
    await ingest(FIX.corrected, T_CORRECT);
    expect(notifier.sent.map((n) => n.type)).toEqual(["event.data_arrived", "event.revised"]);
    expect(notifier.sent[1]!.summary).toBe("Employment Situation (FIXTURE): actual values revised (rev 5)");
  });
});

describe("GET /v1/events 与 /revisions：开关开带 outcome / outcomeRevision / dataStatus；关时不变", () => {
  async function run(on: boolean) {
    const kp = testKeypair();
    env = await createTestEnv({ crowsnestPubkey: `${kp.publicKeyId}=${kp.publicKeyHex}`, env: on ? { AGENT_V7_OUTCOMES_ENABLED: "true" } : {} });
    await env.crowsnest.ingest(signedContext(kp, { at: T_SCHED.toISOString(), events: [FIX.scheduled] }), { endpoint: "test", mode: "LIVE" });
    await env.crowsnest.ingest(signedContext(kp, { at: T_ARRIVE.toISOString(), events: [FIX.arrived] }), { endpoint: "test", mode: "LIVE" });
    const list = (await api(env, "GET", "/v1/events?kind=MACRO_TIER1")).json["events"] as Array<Record<string, unknown>>;
    const revs = (await api(env, "GET", `/v1/events/${encodeURIComponent(ID)}/revisions`)).json["revisions"] as Array<{ event: Record<string, unknown> }>;
    return { ev: list.find((e) => e["id"] === ID)!, revs };
  }
  it("开", async () => {
    const { ev, revs } = await run(true);
    expect(ev).toMatchObject({ revision: 4, outcomeRevision: 0, dataStatus: "data_arrived" });
    expect((ev["outcome"] as { metrics: unknown[] }).metrics).toHaveLength(3);
    expect(revs.map((r) => r.event["dataStatus"])).toEqual(["upcoming", "data_arrived"]);
  });
  it("关", async () => {
    const { ev, revs } = await run(false);
    expect(ev["revision"]).toBe(4);
    for (const e of [ev, ...revs.map((r) => r.event)]) {
      expect(e).not.toHaveProperty("outcome");
      expect(e).not.toHaveProperty("outcomeRevision");
      expect(e).not.toHaveProperty("dataStatus");
    }
  });
});

describe("D-06 财报 outcome 只写源里真有的字段（Finnhub 响应回放）", () => {
  // Finnhub /calendar/earnings 响应形状（2026-09-23 探针，docs/devday-2026/earnings-source-probe.md）；FAKE 标的、合成数值
  const RAW = JSON.stringify({
    earningsCalendar: [
      { date: "2026-10-28", hour: "amc", quarter: 4, year: 2026, symbol: "FAKE", epsActual: 1.25, epsEstimate: null, revenueActual: null, revenueEstimate: null },
      { date: "2026-10-29", hour: "bmo", quarter: 4, year: 2026, symbol: "FAKE2", epsActual: -0.07, epsEstimate: -0.1, revenueActual: 123456789, revenueEstimate: 120000000 },
      { date: "2026-10-30", hour: "", quarter: 4, year: 2026, symbol: "FAKE3", epsActual: null, epsEstimate: 2.5, revenueActual: null, revenueEstimate: 5 },
    ],
  });
  const FETCHED = "2026-10-29T12:00:00.000Z";
  it("无预估 → 不写 expectation；无营收实际值 → 不写营收；数值转十进制串；无实际值 → 没有 outcome", () => {
    const rows = parseEarningsCalendar(RAW, 200)!;
    const a = buildEarningsOutcome(rows[0]!, FETCHED)!;
    expect(a.metrics).toEqual([{ key: "eps", label: "EPS", actual: "1.25", unit: "usd_per_share", period: "FY2026Q4" }]);
    expect(a).toMatchObject({ provider: "finnhub", source: "finnhub:calendar/earnings", publishedAt: FETCHED, fetchedAt: FETCHED });
    const b = buildEarningsOutcome(rows[1]!, FETCHED)!;
    expect(b.metrics).toEqual([
      { key: "eps", label: "EPS", actual: "-0.07", unit: "usd_per_share", period: "FY2026Q4", expectation: { value: "-0.1", kind: "survey", source: "finnhub:epsEstimate", at: FETCHED } },
      { key: "revenue", label: "Revenue", actual: "123456789", unit: "usd", period: "FY2026Q4", expectation: { value: "120000000", kind: "survey", source: "finnhub:revenueEstimate", at: FETCHED } },
    ]);
    expect(buildEarningsOutcome(rows[2]!, FETCHED)).toBeUndefined();
    expect(buildEarningsDraft(rows[2]!, "us-equity:FAKE3", FETCHED).outcome).toBeUndefined();
    expect(decimalFromNumber(1e-7)).toBe("0.0000001");
    expect(decimalFromNumber(1e21)).toBeNull();
  });

  it("财报摄入：发布 → data_arrived（event.data_arrived）；营收后补 → revised（outcome_revision 1）；重抓不制造修订", async () => {
    const t = await testDb();
    closers.push(t.close);
    const st = new DrizzleEventStore(t.db, { outcomes: true, now: () => new Date(NOW) });
    const notifier = new CountingNotifier();
    const propagator = new EventRevisionPropagator({ tasks: notReadyTasks, commands: notReadyCommands, notify: notifier, clock: () => new Date(NOW), publicBaseUrl: "http://test" });
    const hooks: OutcomeHookInfo[] = [];
    const registry = new OutcomeHookRegistry();
    registry.set({ onDataArrived: (_i, h) => void hooks.push(h), onOutcomeRevised: (_i, h) => void hooks.push(h) });
    const source = new FakeEarningsSource({ FAKE: [row()] }, () => new Date(NOW));
    const ing = new EarningsIngestor({ source, registry: fixtureRegistry({ chainId: 196 }), store: st, evidence: new MemoryEvidenceSink(), clock: () => new Date(NOW), spacingMs: 0, onChange: (r) => propagator.onChange(r).then(() => undefined), outcomeHooks: registry });
    const u = { underlyingId: FAKE_UNDERLYING, symbol: "FAKE" };
    await ing.ingestSymbol(u);
    source.rows["FAKE"] = [row({ epsActual: 1.3 })];
    const r1 = (await ing.ingestSymbol(u)).results[0]!;
    expect(r1.change).toBe("data_arrived");
    expect(r1.event).toMatchObject({ status: "released", revision: 2, outcomeRevision: 0, dataStatus: "data_arrived" });
    expect((r1.event as MarketEventV7).outcome!.metrics).toEqual([{ key: "eps", label: "EPS", actual: "1.3", unit: "usd_per_share", period: "FY2026Q4", expectation: { value: "1.2", kind: "survey", source: "finnhub:epsEstimate", at: NOW } }]);
    // 重抓同一数据 → unchanged
    expect((await ing.ingestSymbol(u)).results[0]!.change).toBe("unchanged");
    source.rows["FAKE"] = [row({ epsActual: 1.3, revenueActual: 101 })];
    const r2 = (await ing.ingestSymbol(u)).results[0]!;
    expect(r2).toMatchObject({ change: "revised", changedFields: ["outcome"], outcome: { revision: 1, change: "revised" } });
    expect(notifier.sent.map((n) => n.type)).toEqual(["event.data_arrived", "event.revised"]);
    expect(notifier.sent[1]!.summary).toContain("actual values revised");
    expect(hooks.map((h) => [h.change, h.outcomeRevision, h.provider])).toEqual([
      ["data_arrived", 0, "finnhub"],
      ["revised", 1, "finnhub"],
    ]);
    const revs = await st.revisions(r2.event.id);
    expect(revs.map((r) => (r.event as MarketEventV7).dataStatus)).toEqual(["upcoming", "data_arrived", "revised"]);
  });

  it("开关关：草稿里的 outcome 被忽略（released、无 outcome 字段）；v6 已 released 的旧事件开开关后静默补 outcome，不升 revision", () => {
    const d0 = buildEarningsDraft(row(), FAKE_UNDERLYING, NOW);
    const created = applyDraft(null, d0, NOW).event;
    const d1 = buildEarningsDraft(row({ epsActual: 1.3 }), FAKE_UNDERLYING, NOW);
    const off = applyDraft(created, d1, NOW);
    expect(off.change).toBe("released");
    expect(off.event).not.toHaveProperty("outcome");
    expect(off.outcome).toBeUndefined();
    const backfill = applyDraft(off.event, d1, "2026-10-27T00:00:00.000Z", { outcomes: true });
    expect(backfill.change).toBe("unchanged");
    expect(backfill.event.revision).toBe(off.event.revision);
    expect(backfill.outcome).toMatchObject({ revision: 0, receivedNow: true });
    expect(backfill.outcome!.change).toBeUndefined();
  });

  it("内存实现同样派生 outcomeRevision", async () => {
    const m = new MemoryEventStore({ outcomes: true, now: () => new Date(NOW) });
    await m.upsert(buildEarningsDraft(row(), FAKE_UNDERLYING, NOW), NOW);
    await m.upsert(buildEarningsDraft(row({ epsActual: 1.3 }), FAKE_UNDERLYING, NOW), NOW);
    const r = await m.upsert(buildEarningsDraft(row({ epsActual: 1.31 }), FAKE_UNDERLYING, NOW), NOW);
    expect(r.event).toMatchObject({ outcomeRevision: 1, dataStatus: "revised" });
  });
});
