/** v8 事件台（方案 §5.7）：条件串 / 条件对象 → 人话、事件名按 locale、只为未结束任务算命中、分组与新鲜度。用真实样本（演示钱包，2026-10-03）。 */
import { describe, expect, it } from "vitest";
import type { Condition, MarketEvent, Task } from "@chaconne/core/verify";
import sample from "./fixtures/events-desk-sample.json";
import { conditionLike, conditionText, parseRuleLabel, ruleLabelText } from "@/lib/conditions";
import { dateOnly, dayKeyOf, dayLabel, deviationText, eventName, eventSpan, groupByDay, heartbeatOf, inHorizon, kindMeta, nyMidnightUtc, queryRange, shownAt } from "@/components/features/events/eventText";
import { diffSentence, enabledActions, isOpenStatus, matchEvent, openTasks, ruleSentence, serverBlockers, windowPhase, type TaskLite } from "@/components/features/events/impact";
import { coverageRows } from "@/components/features/events/coverage";
import { ACTION_LABEL, COVERAGE, EVENT_STATUS, sourceName } from "@/components/features/events/copy";
import type { AssetEntry } from "@/lib/assets";

const events = sample.events as unknown as MarketEvent[];
const tasks = sample.tasks as unknown as Task[];
/** 页面上不许出现的原始串：条件函数调用、SNAKE_CASE、JSON */
const RAW = /[a-z]+_[a-z_]+\(|\b[A-Z]+_[A-Z0-9_]+\b|\{"|\b[a-z]+_[a-z]+_[a-z_]+\b/;
const AAPLX = "eip155:196:0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a";
const NVDAX = "eip155:196:0xc845b2894dbddd03858fd2d643b4ef725fe0849d";
const ASSETS = [
  { assetKey: AAPLX, displaySymbol: "AAPLx", underlyingId: "us-equity:AAPL", role: "stock_output", executionAllowed: true, tokenAddress: "0x9d", tokenDecimals: 18 },
  { assetKey: NVDAX, displaySymbol: "NVDAx", underlyingId: "us-equity:NVDA", role: "stock_output", executionAllowed: true, tokenAddress: "0xc8", tokenDecimals: 18 },
] as AssetEntry[];
const ev = (over: Partial<MarketEvent>): MarketEvent => ({ id: "s:MACRO_TIER1:2026-10-07:x", kind: "MACRO_TIER1", name: "CPI", underlyingIds: [], scheduledAtUtc: "2026-10-07T12:30:00.000Z", dateLocal: "2026-10-07", datePrecision: "exact", sessionHint: null, status: "confirmed", revision: 0, source: "crowsnest.fred", sourceFetchedAt: "2026-10-03T07:00:00.000Z", firstKnownAt: "2026-09-23T08:00:00.000Z", tz: "America/New_York", ...over });
const lite = (over: Partial<TaskLite>): TaskLite => ({ id: "tsk_a", title: "任务 A", status: "waiting", conditions: [], watchKinds: [], assetKeys: [], ...over });
const avoid = (kinds: string[], b: number, a: number, extra: Partial<Extract<Condition, { type: "avoid_event_window" }>> = {}): Condition => ({ type: "avoid_event_window", kinds: kinds as never, beforeMin: b, afterMin: a, includeEstimated: false, wholeDayIfDayPrecision: false, ...extra });

describe("条件串 / 条件对象 → 人话（验收：页面无 avoid_event_window(...) 原始串）", () => {
  it("服务端规则标签翻成人话", () => {
    expect(ruleLabelText("avoid_event_window(MACRO_TIER1|FED_SPEECH,30,20)", "zh")).toBe("一级宏观数据、联储讲话前 30 分钟到后 20 分钟暂停");
    expect(ruleLabelText("avoid_event_window(MACRO_TIER1|FED_SPEECH,30,20)", "en")).toBe("Pause from 30 min before to 20 min after tier-1 macro releases, Fed speeches");
    expect(ruleLabelText("earnings_window(2,1)", "zh")).toBe("财报前 2 个交易日、后 1 个时段内等待");
    expect(parseRuleLabel("avoid_event_window(MACRO_TIER1,60,60)")).toMatchObject({ type: "avoid_event_window", kinds: ["MACRO_TIER1"], beforeMin: 60, afterMin: 60 });
  });
  it("真实样本里的每条规则标签都不露原串", () => {
    const labels = sample.impactItems.flatMap((i) => i.rules.map((r) => r.ruleLabel));
    expect(labels.length).toBeGreaterThan(0);
    for (const l of labels) for (const loc of ["zh", "en"] as const) expect(ruleLabelText(l, loc)).not.toMatch(RAW);
  });
  it("认不出的串、未知条件类型、跨资产状态都不露原值", () => {
    expect(parseRuleLabel("something_new(1,2)")).toBeNull();
    expect(ruleLabelText("something_new(1,2)", "zh")).not.toMatch(RAW);
    expect(conditionText({ type: "brand_new_kind", x: 1 } as unknown as Condition, "zh")).toBe("另有一条自定义条件");
    expect(conditionText({ type: "require_cross_asset_confirmation", acceptStates: ["relief", "divergence"] }, "zh")).toBe("要求跨资产确认（缓和、背离）");
    expect(conditionLike({ foo: 1 }, "en")).toBe("A condition");
  });
  it("预览差异：条件串与条件对象都翻成句子", () => {
    expect(diffSentence({ before: null, after: "avoid_event_window(MACRO_TIER1,30,20)" }, "zh")).toBe("新增：一级宏观数据前 30 分钟到后 20 分钟暂停");
    const s = diffSentence({ before: avoid(["MACRO_TIER1"], 30, 20), after: avoid(["MACRO_TIER1", "FED_SPEECH"], 60, 60) }, "en");
    expect(s).toMatch(/^Change to: Avoid 60 min before/);
    expect(s).not.toMatch(RAW);
  });
});

describe("事件名按 locale", () => {
  it("中文页：财报英文名换成中文；中文名原样", () => {
    const mu = events.find((e) => e.kind === "EARNINGS")!;
    expect(eventName(mu, "zh")).toBe("MU 财报（FY2026 Q4）");
    expect(eventName(events.find((e) => e.id.includes(":pce"))!, "zh")).toBe("PCE物价");
  });
  it("英文页：真实样本里没有一个中文名", () => {
    for (const e of events) expect(eventName(e, "en")).not.toMatch(/[㐀-鿿]/);
    expect(eventName(ev({ name: "Bowman 讲话（投票·待定）" }), "en")).toBe("Bowman speech (voter, undecided)");
    expect(eventName(ev({ name: "10Y国债拍卖" }), "en")).toBe("10-year Treasury auction");
    expect(eventName(ev({ name: "FOMC 9月会议纪要" }), "en")).toBe("FOMC minutes (Sep meeting)");
    expect(eventName(ev({ name: "某个新事件" }), "en")).toBe("Tier-1 macro · Oct 7");
  });
  it("接口按 locale 给的字段优先", () => {
    expect(eventName({ ...ev({ name: "CPI" }), nameZh: "消费者物价指数" } as MarketEvent, "zh")).toBe("消费者物价指数");
    expect(eventName({ ...ev({ name: "非农就业" }), names: { en: "Nonfarm payrolls (Sep)" } } as unknown as MarketEvent, "en")).toBe("Nonfarm payrolls (Sep)");
  });
  it("每个类型都有中英文等级标签；状态、来源都有文案", () => {
    for (const k of ["MACRO_TIER1", "MACRO_TIER2", "FED_SPEECH", "FED_BLACKOUT", "EARNINGS", "CORPORATE_ACTION", "MARKET_HOLIDAY", "EARLY_CLOSE"]) expect(kindMeta(k).zh).not.toMatch(RAW);
    for (const e of events) { expect(EVENT_STATUS[e.status]).toBeTruthy(); expect(sourceName(e.source, "zh")).not.toMatch(/crowsnest|\./); }
    for (const a of Object.values(ACTION_LABEL)) expect(a.zh).not.toMatch(RAW);
    expect(Object.keys(COVERAGE).sort()).toEqual(["covered", "not_probed", "unavailable", "unknown"]);
  });
});

describe("只为未结束的任务算命中（走查：29 个任务多数已结束，首屏 27 秒）", () => {
  const open = openTasks(tasks, "zh");
  it("已完成 / 取消 / 到期 / 撤销中的任务不参与", () => {
    expect(open.length).toBeLessThan(tasks.length);
    expect(open.every((t) => isOpenStatus(t.status))).toBe(true);
    expect(open.map((t) => t.id)).not.toContain("tsk_143b2d7671cd192f5c668f39"); // CANCELLED，服务端仍把它算进 PCE 命中
    expect(isOpenStatus("revoking")).toBe(false);
  });
  it("真实样本：PCE（一级宏观）命中的未结束任务 ⊂ 服务端命中，且已取消的被剔除", () => {
    const pce = events.find((e) => e.id.includes(":pce"))!;
    const server = sample.impactItems.find((i) => i.eventId === pce.id)!.tasks.map((t) => t.taskId);
    const mine = matchEvent(pce, open, []).filter((h) => h.rules.some((r) => r.kind === "avoid")).map((h) => h.task.id);
    expect(mine.length).toBeGreaterThan(0);
    for (const id of mine) expect(server).toContain(id);
    expect(mine).not.toContain("tsk_92e865998b5cfb294f95b147");
  });
  it("估计日期只命中 includeEstimated 的规则；公司事件规则只对涉及该股票的任务生效", () => {
    const est = ev({ status: "estimated", datePrecision: "estimate" });
    expect(matchEvent(est, [lite({ conditions: [avoid(["MACRO_TIER1"], 30, 20)] })], [])).toHaveLength(0);
    expect(matchEvent(est, [lite({ conditions: [avoid(["MACRO_TIER1"], 30, 20, { includeEstimated: true, wholeDayIfDayPrecision: true })] })], [])[0]!.rules[0]).toMatchObject({ kind: "avoid", window: { basis: "whole_day" } });
    const earnings = ev({ kind: "EARNINGS", underlyingIds: ["us-equity:AAPL"] });
    const t = lite({ conditions: [{ type: "earnings_window", beforeTradingDays: 2, afterSessions: 1, requireRegularSessionAfter: true, requireLiveReferenceAfter: true }], assetKeys: [NVDAX] });
    expect(matchEvent(earnings, [t], [AAPLX])).toHaveLength(0);
    expect(matchEvent(earnings, [{ ...t, assetKeys: [AAPLX] }], [AAPLX])[0]!.rules[0]!.kind).toBe("earnings");
    expect(matchEvent(earnings, [lite({ assetKeys: [AAPLX] })], [AAPLX], () => "AAPLx")[0]!.rules[0]).toEqual({ kind: "asset", symbols: ["AAPLx"] });
    expect(matchEvent(ev({}), [lite({ watchKinds: ["MACRO_TIER1"] })], [])[0]!.rules[0]!.kind).toBe("watch");
  });
  it("一句人话（验收例句）", () => {
    const [hit] = matchEvent(ev({}), [lite({ conditions: [avoid(["MACRO_TIER1", "FED_SPEECH"], 30, 20)] })], []);
    expect(ruleSentence(hit!.rules[0]!, "zh", "任务 A")).toBe("任务 A 会在事件前 30 分钟到后 20 分钟暂停买入");
    expect(ruleSentence(hit!.rules[0]!, "en", "Task A")).toBe("Task A pauses buying from 30 min before to 20 min after the event");
    const w = hit!.rules[0]!.kind === "avoid" ? hit!.rules[0]!.window! : null;
    expect(w && windowPhase(w, Date.parse("2026-10-07T12:10:00Z"))).toBe("active");
  });
  it("所有句型中英文都不露原串", () => {
    const rules = [
      ...matchEvent(ev({}), [lite({ conditions: [avoid(["MACRO_TIER1"], 30, 20)] })], [])[0]!.rules,
      ...matchEvent(ev({ datePrecision: "day", scheduledAtUtc: null }), [lite({ conditions: [avoid(["MACRO_TIER1"], 30, 20)] })], [])[0]!.rules,
      { kind: "earnings" as const, c: { type: "earnings_window" as const, beforeTradingDays: 2, afterSessions: 1, requireRegularSessionAfter: true, requireLiveReferenceAfter: true } },
      { kind: "watch" as const },
      { kind: "asset" as const, symbols: ["AAPLx"] },
    ];
    for (const r of rules) for (const loc of ["zh", "en"] as const) { expect(ruleSentence(r, loc)).not.toMatch(RAW); expect(ruleSentence(r, loc)).not.toContain("——"); }
  });
  it("动作口径与服务端一致；主动作「预览条件变更」始终可用", () => {
    expect(enabledActions(ev({}), [])).toEqual(["view_evidence", "keep_plan", "preview_new_plan"]);
    const hits = matchEvent(ev({}), [lite({ conditions: [avoid(["MACRO_TIER1"], 30, 20)] })], []);
    expect(enabledActions(ev({}), hits)).toEqual(["view_evidence", "create_watch_task", "keep_plan", "wait_by_rule", "pause_issuance", "preview_new_plan"]);
    expect(ACTION_LABEL.preview_new_plan.zh).toBe("预览条件变更");
  });
  it("服务端阻塞说明只保留未结束任务", () => {
    const rules = [
      { taskId: "tsk_open", ruleLabel: "avoid_event_window(MACRO_TIER1,30,20)", active: true, needsChoice: false, nextCheckAt: "2026-10-07T12:50:00Z" },
      { taskId: "tsk_cancelled", ruleLabel: "earnings_window(2,1)", active: true, needsChoice: false, nextCheckAt: "2026-10-08T20:00:00Z" },
    ];
    expect(serverBlockers(rules, new Set(["tsk_open"]))).toEqual([{ code: "EVENT_WINDOW_ACTIVE", nextCheckAt: "2026-10-07T12:50:00Z" }]);
  });
});

describe("范围、分组、新鲜度", () => {
  const now = Date.parse("2026-10-03T08:00:00Z");
  it("纽约本地零点（夏令 / 冬令）", () => {
    expect(new Date(nyMidnightUtc("2026-10-05")).toISOString()).toBe("2026-10-05T04:00:00.000Z");
    expect(new Date(nyMidnightUtc("2026-12-01")).toISOString()).toBe("2026-12-01T05:00:00.000Z");
  });
  it("范围：已取消、太远、早已过去的不列；窗口仍在进行的列出", () => {
    expect(inHorizon(ev({ scheduledAtUtc: "2026-10-04T12:30:00Z" }), now, 48)).toBe(true);
    expect(inHorizon(ev({ scheduledAtUtc: "2026-10-06T12:30:00Z" }), now, 48)).toBe(false);
    expect(inHorizon(ev({ status: "cancelled", scheduledAtUtc: "2026-10-04T12:30:00Z" }), now, 48)).toBe(false);
    expect(inHorizon(ev({ scheduledAtUtc: "2026-10-03T03:00:00Z" }), now, 48)).toBe(false);
    expect(inHorizon(ev({ scheduledAtUtc: "2026-10-03T03:00:00Z" }), now, 48, Date.parse("2026-10-03T09:00:00Z"))).toBe(true);
    expect(queryRange(now, 72)).toEqual({ from: "2026-10-02", to: "2026-10-07" });
  });
  it("按天分组、组内按时间；只有日期的事件按来源日期", () => {
    const groups = groupByDay(events.filter((e) => e.dateLocal >= "2026-10-05"), (e) => e);
    expect(groups.map((g) => g.key)).toEqual([...groups.map((g) => g.key)].sort());
    const at = (e: MarketEvent) => shownAt(e) ?? eventSpan(e).startMs;
    for (const g of groups) for (let i = 1; i < g.rows.length; i++) expect(at(g.rows[i]!)).toBeGreaterThanOrEqual(at(g.rows[i - 1]!));
    expect(dayKeyOf(ev({ datePrecision: "day", scheduledAtUtc: null, dateLocal: "2026-10-09" }))).toBe("2026-10-09");
    // 估计时刻：分组跟着行上显示的本地时间走，避免「10/05 组里写 10/06 00:00」
    const est = ev({ datePrecision: "estimate", status: "estimated", scheduledAtUtc: "2026-10-05T14:00:00Z", dateLocal: "2026-10-05" });
    const d = new Date(Date.parse("2026-10-05T14:00:00Z"));
    expect(dayKeyOf(est)).toBe(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
    expect(shownAt(ev({ scheduledAtUtc: null }))).toBeNull();
    const today = new Date(now);
    const key = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
    expect(dayLabel(key, "zh", now)).toMatch(/^今天 · \d{2}\/\d{2} /);
    expect(dayLabel(key, "en", now)).toMatch(/^Today · /);
  });
  it("偏差：改期给方向与幅度；没改期写一致；拿不到原定写未返回", () => {
    expect(deviationText(ev({ revision: 1, revisedFrom: { scheduledAtUtc: "2026-10-06T12:30:00.000Z", dateLocal: "2026-10-06" } }), "zh")).toBe("较原定推迟 1 天（原定 10月6日）");
    expect(deviationText(ev({}), "zh")).toBe("与首次发布一致");
    expect(deviationText(ev({ revision: 3 }), "zh")).toBe("已修订 3 次（原定时间未返回）");
  });
  it("心跳 = 同一来源最近一次抓取；没有就 null（页面写「未返回」）", () => {
    expect(heartbeatOf("crowsnest.treasury", events)).toBe("2026-09-25T19:12:00.000Z");
    expect(heartbeatOf("nope", events)).toBeNull();
    expect(heartbeatOf(null, events)).not.toBeNull();
  });
  it("财报覆盖：登记表外跳过；下一份财报取今天之后最早的", () => {
    const rows = coverageRows([
      { underlyingId: "us-equity:AAPL", state: "covered", lastProbedAt: "2026-10-03T04:52:22.558Z", eventIds: ["finnhub:EARNINGS:2027-01-27:AAPL", "finnhub:EARNINGS:2026-10-28:AAPL", "finnhub:EARNINGS:2026-07-30:AAPL"] },
      { underlyingId: "us-equity:NVDA", state: "unknown", lastProbedAt: null, eventIds: [] },
      { underlyingId: "us-equity:ZZZ", state: "covered", lastProbedAt: null, eventIds: [] },
    ], ASSETS, "2026-10-03");
    expect(rows).toEqual([
      { symbol: "AAPLx", state: "covered", lastProbedAt: "2026-10-03T04:52:22.558Z", nextReport: "2026-10-28" },
      { symbol: "NVDAx", state: "unknown", lastProbedAt: null, nextReport: null },
    ]);
  });
});

describe("日期不直出 ISO（审查组 B-6）", () => {
  it("只有日期 → 10月6日 / Oct 6；格式不对写未返回", () => {
    expect(dateOnly("2026-10-06", "zh")).toBe("10月6日");
    expect(dateOnly("2026-10-06", "en")).toBe("Oct 6");
    expect(dateOnly("bad", "zh")).toBe("日期未返回");
  });
  it("没有名字的事件：类型 · 本地化日期", () => {
    const e = ev({ name: "", kind: "EARNINGS", dateLocal: "2026-10-07" });
    expect(eventName(e, "zh")).toBe("财报 · 10月7日");
    expect(eventName(e, "en")).toBe("Earnings · Oct 7");
  });
  it("改期的英文说明也不出 ISO", () => {
    expect(deviationText(ev({ revision: 1, revisedFrom: { scheduledAtUtc: "2026-10-06T12:30:00.000Z", dateLocal: "2026-10-06" } }), "en")).toBe("Delayed by 1 d (was Oct 6)");
  });
});
