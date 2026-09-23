/** v6 Lane B · C1 MarketContext 纯函数：X-01 canonical 黄金样本 / X-02 staleness / X-04 档位 / X-05 过滤 / X-06 未知键 / X-07 估计事件 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/verify/canonical";
import { assessContextStaleness, CONTEXT_FIELD_PATHS, contextField, contextHash, contextSigningPayload, filterContext, filterFromConditions, trimContextToTier, validateMarketContext } from "../src/verify/context";
import { fixtureEvent, fixtureMarketContext } from "../src/verify/context/fixture";
import { eventWindow, mergeEventRevision } from "../src/verify/events";

const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "verify", "__fixtures__", "v6");
const golden = (name: string) => JSON.parse(readFileSync(join(GOLDEN_DIR, `${name}.json`), "utf8")) as { canonicalVersion: string; input: Record<string, unknown>; canonical: string; canonicalUtf8Sha256: string; signature: string; publicKeyHex: string };

describe("X-01 canonical 黄金样本（Lane A crowsnest ↔ TS canon-1 逐字节对拍）", () => {
  for (const name of ["context_canon_1_edge", "context_canon_2_rates", "context_canon_3_event"]) {
    it(`X-01 ${name}：canonicalJson(input) 与样本 canonical 逐字节一致、sha256 一致`, () => {
      const g = golden(name);
      expect(g.canonicalVersion).toBe("canon-1");
      const c = canonicalJson(g.input);
      expect(c).toBe(g.canonical);
      expect(contextSigningPayload({ ...g.input, signature: g.signature })).toBe(g.canonical);
      expect(createHash("sha256").update(Buffer.from(c, "utf8")).digest("hex")).toBe(g.canonicalUtf8Sha256);
    });
  }
});

const AT = "2026-09-18T15:00:00.000Z"; // 周五 11:00 ET（常规时段）

describe("X-06 结构校验：只保留契约键、CV-D12 数值字符串", () => {
  it("X-06 未知顶层键（analyst/forecast/thresholds）被剥离，不进入重建后的对象；contextHash 仍按原文算", () => {
    const raw = { ...fixtureMarketContext({ at: AT }), signature: "0x00", analyst: { btcThesis: "private" }, forecast: [1, 2], thresholds: { vix: 30 } } as Record<string, unknown>;
    const v = validateMarketContext(raw);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(JSON.stringify(v.ctx)).not.toMatch(/analyst|forecast|thresholds|btcThesis/);
    // 签名载荷/哈希覆盖原文全部键（含被剥离的）
    expect(contextHash(raw)).not.toBe(contextHash(v.ctx as unknown as Record<string, unknown>));
  });
  it("CV-D12 数值给成 number → 拒收；缺字段 → 拒收（不用默认值冒充）", () => {
    const ctx = fixtureMarketContext({ at: AT }) as unknown as Record<string, unknown>;
    const bad = structuredClone(ctx);
    ((bad["risk"] as Record<string, Record<string, unknown>>)["vix"] as Record<string, unknown>)["value"] = 17.85;
    const r1 = validateMarketContext(bad);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.errors.some((e) => e.path === "risk.vix.value")).toBe(true);
    const missing = structuredClone(ctx);
    delete (missing["rates"] as Record<string, unknown>)["move"];
    const r2 = validateMarketContext(missing);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.errors.some((e) => e.path === "rates.move")).toBe(true);
  });
  it("CV-D13 provenance.mode 非法 → 拒收；缺省合法", () => {
    const ctx = fixtureMarketContext({ at: AT }) as unknown as Record<string, unknown>;
    expect(validateMarketContext({ ...ctx, provenance: { mode: "archive" } }).ok).toBe(false);
    expect(validateMarketContext({ ...ctx, provenance: { mode: "backfill", note: "x" } }).ok).toBe(true);
    expect(validateMarketContext(ctx).ok).toBe(true);
  });
  it("crowsnest 时间格式 +00:00 也接受", () => {
    const ctx = fixtureMarketContext({ at: "2026-09-18T15:00:00+00:00" });
    expect(validateMarketContext(ctx).ok).toBe(true);
  });
});

describe("X-02 逐字段 staleness（服务判定，不信 producer 自报）", () => {
  it("X-02 session 10 分钟、fed.hikeProb 15 分钟、events 60 分钟；producer 自报 ok 不算数", () => {
    const ctx = fixtureMarketContext({ at: AT });
    const fresh = assessContextStaleness(ctx, "2026-09-18T15:05:00.000Z");
    expect(fresh["session.label"]).toBe("ok");
    expect(fresh["fed.hikeProb"]).toBe("ok");
    expect(fresh["events"]).toBe("ok");
    const later = assessContextStaleness(ctx, "2026-09-18T15:20:00.000Z");
    expect(later["session.label"]).toBe("stale");
    expect(later["fed.hikeProb"]).toBe("stale");
    expect(later["events"]).toBe("ok");
    const hour = assessContextStaleness(ctx, "2026-09-18T16:01:00.000Z");
    expect(hour["events"]).toBe("stale");
    expect(hour["driftVerdict"]).toBe("stale");
  });
  it("X-02 日度定盘（rates.*）：下一交易日 18:00 ET 前有效；跨周末：周五定盘到周一 18:00 ET 仍 ok", () => {
    const ctx = fixtureMarketContext({ at: AT, overrides: { ratesObservedAt: "2026-09-18T20:00:00.000Z" } });
    expect(assessContextStaleness(ctx, "2026-09-20T12:00:00.000Z")["rates.y10"]).toBe("ok"); // 周日
    expect(assessContextStaleness(ctx, "2026-09-21T21:59:00.000Z")["rates.y10"]).toBe("ok"); // 周一 17:59 ET
    expect(assessContextStaleness(ctx, "2026-09-21T22:01:00.000Z")["rates.y10"]).toBe("stale"); // 周一 18:01 ET
  });
  it("X-02 risk.*：常规时段 20 分钟；休市按最后收盘并要求 observedAt 标注", () => {
    const ctx = fixtureMarketContext({ at: AT });
    expect(assessContextStaleness(ctx, "2026-09-18T15:15:00.000Z")["risk.vix"]).toBe("ok");
    expect(assessContextStaleness(ctx, "2026-09-18T15:25:00.000Z")["risk.vix"]).toBe("stale");
    // 周六：observedAt 在周五（最近已完成交易日）→ ok；observedAt 缺失 → stale
    expect(assessContextStaleness(ctx, "2026-09-19T15:00:00.000Z")["risk.vix"]).toBe("ok");
    const noObs = fixtureMarketContext({ at: AT, overrides: { riskObservedAt: null } });
    expect(assessContextStaleness(noObs, "2026-09-19T15:00:00.000Z")["risk.vix"]).toBe("stale");
  });
  it("X-02 unfinished：observedAt 晚于评估时点的区间不得当已发生观测；value=null 一律 unavailable", () => {
    const ctx = fixtureMarketContext({ at: AT, overrides: { ratesObservedAt: "2026-09-18T20:00:00.000Z", vix: null } });
    const s = assessContextStaleness(ctx, "2026-09-18T15:05:00.000Z");
    expect(s["rates.y10"]).toBe("unfinished");
    expect(s["risk.vix"]).toBe("unavailable");
  });
});

describe("X-04 档位裁剪：不省略键", () => {
  it("X-04 agent 档：risk.* 整个字段变成 {status:'unavailable', note:'not_in_tier'}，其余字段与全部键保留", () => {
    const ctx = fixtureMarketContext({ at: AT });
    const agent = trimContextToTier(ctx, "agent");
    for (const [path] of CONTEXT_FIELD_PATHS) expect(contextField(agent, path), path).not.toBeNull();
    expect(contextField(agent, "risk.vix")).toMatchObject({ value: null, status: "unavailable", note: "not_in_tier" });
    expect(contextField(agent, "rates.y10")).toMatchObject({ value: "4.96", status: "ok" });
    expect(contextField(trimContextToTier(ctx, "display"), "risk.vix")).toMatchObject({ value: "17.85" });
    expect(contextField(trimContextToTier(ctx, "internal"), "risk.vix")).toMatchObject({ value: "17.85" });
    // 即便 producer 把 risk 标成 agent 可见，服务侧策略仍拦（D-084 防御）
    const mislabeled = fixtureMarketContext({ at: AT });
    mislabeled.risk.vix.purposes = ["internal", "display", "agent", "paid"];
    expect(contextField(trimContextToTier(mislabeled, "agent"), "risk.vix")?.note).toBe("not_in_tier");
  });
});

describe("X-05 按资产/任务过滤", () => {
  const events = [
    fixtureEvent({ kind: "MACRO_TIER1", name: "CPI", dateLocal: "2026-09-18", scheduledAtUtc: "2026-09-18T12:30:00.000Z" }),
    fixtureEvent({ kind: "EARNINGS", name: "FAKE Q3", dateLocal: "2026-09-25", underlyingIds: ["us-equity:FAKE"], sessionHint: "amc" }),
    fixtureEvent({ kind: "EARNINGS", name: "OTHER Q3", dateLocal: "2026-09-25", underlyingIds: ["us-equity:OTHER"], sessionHint: "amc" }),
  ];
  it("X-05 资产过滤：宏观事件 + 该标的的公司事件；其它公司事件不回", () => {
    const ctx = fixtureMarketContext({ at: AT, events });
    const f = filterContext(ctx, { underlyingIds: ["us-equity:FAKE"] });
    expect(f.events.map((e) => e.name).sort()).toEqual(["CPI", "FAKE Q3"]);
  });
  it("X-05 任务过滤：只回条件引用的事件类型与字段；无关字段标 not_relevant 但键保留", () => {
    const ctx = fixtureMarketContext({ at: AT, events });
    const cond = filterFromConditions([{ type: "session", allow: ["US_REGULAR"] }, { type: "max_vix", value: 30 }]);
    const f = filterContext(ctx, { underlyingIds: ["us-equity:FAKE"], ...cond });
    expect(f.events.map((e) => e.name)).toEqual([]); // 没有 avoid_event_window → 宏观事件不相关；EARNINGS 未被引用
    expect(contextField(f, "risk.vix")?.status).toBe("ok");
    expect(contextField(f, "rates.y10")).toMatchObject({ status: "unavailable", note: "not_relevant" });
    expect(contextField(f, "session.label")?.status).toBe("ok");
  });
});

describe("X-07 估计事件不冒充确认；修订合并", () => {
  it("X-07 datePrecision=estimate 的事件不产生 exact 窗口；日精度不预选整日 → uncertain", () => {
    const est = fixtureEvent({ dateLocal: "2026-09-25", datePrecision: "estimate", scheduledAtUtc: "2026-09-25T12:30:00.000Z", status: "estimated" });
    expect(eventWindow(est, { beforeMin: 30, afterMin: 20, includeEstimated: true, wholeDayIfDayPrecision: true }).kind).toBe("whole_day");
    expect(eventWindow(est, { beforeMin: 30, afterMin: 20, includeEstimated: false, wholeDayIfDayPrecision: true }).kind).toBe("ignored");
    const day = fixtureEvent({ dateLocal: "2026-09-25" });
    expect(eventWindow(day, { beforeMin: 30, afterMin: 20, includeEstimated: true, wholeDayIfDayPrecision: false }).kind).toBe("uncertain");
    const exact = fixtureEvent({ dateLocal: "2026-09-25", scheduledAtUtc: "2026-09-25T12:30:00.000Z" });
    const w = eventWindow(exact, { beforeMin: 30, afterMin: 20, includeEstimated: false, wholeDayIfDayPrecision: false });
    expect(w).toMatchObject({ kind: "exact", fromMs: Date.parse("2026-09-25T12:00:00.000Z"), toMs: Date.parse("2026-09-25T12:50:00.000Z") });
  });
  it("修订合并：revision 递增才更新；firstKnownAt 取首次入库与 producer 值的较早者；改期保留 revisedFrom", () => {
    const v0 = fixtureEvent({ dateLocal: "2026-09-24", scheduledAtUtc: "2026-09-24T12:30:00.000Z", firstKnownAt: "2026-09-20T01:05:00.000Z" });
    const first = mergeEventRevision(null, v0, "2026-09-21T00:00:00.000Z")!;
    expect(first.isNew).toBe(true);
    expect(first.event.firstKnownAt).toBe("2026-09-20T01:05:00.000Z");
    const late = mergeEventRevision(null, { ...v0, firstKnownAt: "2026-09-30T00:00:00.000Z" }, "2026-09-21T00:00:00.000Z")!;
    expect(late.event.firstKnownAt).toBe("2026-09-21T00:00:00.000Z");
    expect(mergeEventRevision(first.event, v0, "2026-09-22T00:00:00.000Z")).toBeNull();
    const v1 = mergeEventRevision(first.event, { ...v0, revision: 1, dateLocal: "2026-09-25", scheduledAtUtc: "2026-09-25T12:30:00.000Z" }, "2026-09-22T00:00:00.000Z")!;
    expect(v1.isRevision).toBe(true);
    expect(v1.event.revisedFrom).toEqual({ scheduledAtUtc: "2026-09-24T12:30:00.000Z", dateLocal: "2026-09-24" });
    expect(v1.event.firstKnownAt).toBe("2026-09-20T01:05:00.000Z");
  });
});
