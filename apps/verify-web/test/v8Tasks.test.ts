import { describe, expect, it } from "vitest";
import type { Task } from "@chaconne/core/verify";
import type { ActivityItem, RecordItem } from "@/lib/api-v2";
import type { EventDeskItem } from "@/components/agent/events/api";
import { deleteConsequence, filterRows, groupCounts, mergeTaskRows, nextStep, parseGroup, parseMode, recordOnlyTaskIds, rowTitle, spentForTask, type AssetInfo } from "@/components/features/tasks/model";
import { agentSayings, availableBudget, fillsToday, needAction, needsList, pickPulseTasks, PULSE_CAP, PULSE_LIMIT, tidyQuote, upcomingEvents, type Pulse } from "@/components/features/today/model";
import { FUNDS_ALLOWANCES_HREF, needExternalHref } from "@/components/features/common/needsAction";

const USDG = "eip155:196:0x4ae46a509f6b1d9056937ba4500cb143933d2dc8";
const AAPL = "eip155:196:0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a";
const NVDA = "eip155:196:0xc845b2894dbddd03858fd2d643b4ef725fe0849d";
const ASSETS = [
  { assetKey: USDG, tokenAddress: USDG.slice(11), tokenDecimals: 6, displaySymbol: "USDG", role: "stable_input" },
  { assetKey: AAPL, tokenAddress: AAPL.slice(11), tokenDecimals: 18, displaySymbol: "AAPLx", role: "stock_output" },
  { assetKey: NVDA, tokenAddress: NVDA.slice(11), tokenDecimals: 18, displaySymbol: "NVDAx", role: "stock_output" },
] as const satisfies readonly (AssetInfo & { tokenAddress: string })[];
const RAW = /\b[A-Z]+_[A-Z_]+\b|0x[0-9a-f]{6,}|\btsk_/;

function task(id: string, over: Partial<Task> = {}): Task {
  return {
    id, owner: "0xbacb138e0e9e1444bae9b401c4615378c57c0381", playbookId: "agent_goal",
    goal: { side: "buy", legs: [{ outputAssetKey: AAPL, weightBps: 10000 }], budget: { amountInRaw: "6000000", inputAssetKeys: [USDG] } },
    conditions: { version: "conditions/1", items: [] },
    scope: { objective: "两天内分两次买入 AAPLx", inputAssetKey: USDG, outputAssetKeys: [AAPL, NVDA], budgetCapRaw: "6000000", perStepCapRaw: "2000000", allowSell: false },
    mandateIds: [], status: "ACTIVE", blockers: [], nextCheckAt: null, executorPresence: "offline",
    createdAt: "2026-10-03T01:00:00.000Z", updatedAt: "2026-10-03T04:00:00.000Z",
    ...over,
  } as unknown as Task;
}
const rec = (r: Partial<RecordItem> & Pick<RecordItem, "kind" | "id">): RecordItem => ({ createdAt: "2026-10-03T01:00:00.000Z", ...r });

describe("v8 tasks: merging /v1/tasks with /v1/records", () => {
  const listed = [task("tsk_listed", { status: "WAITING" })];
  const records: RecordItem[] = [
    rec({ kind: "task", id: "tsk_listed", mode: "SIMULATION" }),
    rec({ kind: "task", id: "tsk_bykey", mode: "LIVE", status: "PAUSED", playbookId: "session_dca", side: "buy", inputAssetKey: USDG, outputAssetKeys: [AAPL], params: { perStepAmountRaw: "2000000", steps: 3 } }),
    rec({ kind: "mandate", id: "mnd_buy", taskId: "tsk_bykey", status: "COMPLETED", inputAssetKey: USDG, spent: "6000000", budgetCap: "6000000" }),
    rec({ kind: "mandate", id: "mnd_sell", taskId: "tsk_bykey", status: "PAUSED", inputAssetKey: AAPL, spent: "0", budgetCap: "38989493130023483" }),
    rec({ kind: "job", id: "job_1" }),
  ];

  it("tasks created with an Agent API key (records only) are in the same list", () => {
    expect(recordOnlyTaskIds(listed, records)).toEqual(["tsk_bykey"]);
    const rows = mergeTaskRows({ listed, details: {}, records, assets: ASSETS, locale: "zh" });
    expect(rows.map((r) => r.id).sort()).toEqual(["tsk_bykey", "tsk_listed"]);
    const byKey = rows.find((r) => r.id === "tsk_bykey")!;
    expect(byKey.mode).toBe("LIVE");
    expect(byKey.status).toBe("paused");
    expect(byKey.title).toBe("分段定投 · AAPLx · 2 USDG × 3");
  });

  it("a fetched detail replaces the bare record", () => {
    const rows = mergeTaskRows({ listed, details: { tsk_bykey: { task: task("tsk_bykey", { status: "PAUSED", scope: { objective: "Chaconne Agent first live hosted run", allowSell: true, outputAssetKeys: [AAPL, NVDA] } as Task["scope"] }), mode: "LIVE" } }, records, assets: ASSETS, locale: "zh" });
    const r = rows.find((x) => x.id === "tsk_bykey")!;
    expect(r.title).toBe("Chaconne Agent first live hosted run");
    expect(r.stocks).toEqual(["AAPLx", "NVDAx"]);
    expect(r.allowSell).toBe(true);
    expect(r.task).not.toBeNull();
  });

  it("budget used counts buy authorizations only (sell authorizations take the stock as input)", () => {
    expect(spentForTask("tsk_bykey", "LIVE", records, ASSETS, USDG)).toBe("6000000");
    expect(spentForTask("tsk_listed", "SIMULATION", records, ASSETS, USDG)).toBeNull();
    expect(spentForTask("tsk_none", "LIVE", records, ASSETS, USDG)).toBe("0");
  });

  it("stocks show names, never contract addresses, and buy-only tasks do not allow selling", () => {
    const rows = mergeTaskRows({ listed, details: {}, records, assets: ASSETS, locale: "zh" });
    for (const r of rows) {
      expect(r.title).not.toMatch(/0x[0-9a-f]{4}/);
      for (const s of r.stocks) expect(s).not.toMatch(/0x/);
    }
    expect(rows.find((r) => r.id === "tsk_listed")!.allowSell).toBe(false);
    const unknown = mergeTaskRows({ listed, details: {}, records: null, assets: [], locale: "zh" });
    expect(unknown[0]!.stocks).toEqual(["未登记资产"]);
  });

  it("template title without params stays readable", () => {
    expect(rowTitle({ playbookId: "session_dca" } as Task, null, ["AAPLx"], ASSETS[0], "en")).toBe("Session DCA · AAPLx");
  });
});

describe("v8 tasks: next step sentence", () => {
  it("never shows raw codes", () => {
    for (const locale of ["zh", "en"] as const) {
      const n = nextStep(task("t", { status: "WAITING", blockers: [{ code: "SOME_UNMAPPED_CODE" } as unknown as Task["blockers"][number]], nextCheckAt: "2026-10-03T05:00:00.000Z" as Task["nextCheckAt"] }), locale);
      expect(n.text).not.toMatch(RAW);
      expect(n.label).toBe("next_check");
    }
  });
  it("paused / awaiting / ended have their own lines", () => {
    expect(nextStep(task("t", { status: "PAUSED" }), "zh").text).toContain("已暂停");
    expect(nextStep(task("t", { status: "AWAITING_AUTHORIZATION" }), "zh").label).toBeNull();
    expect(nextStep(task("t", { status: "COMPLETED" }), "zh").text).toContain("已结束");
    expect(nextStep(task("t", { status: "REVOKE_PENDING" }), "zh").text).toContain("撤销");
  });
});

describe("v8 tasks: filters", () => {
  const rows = mergeTaskRows({ listed: [task("a", { status: "ACTIVE" }), task("b", { status: "PAUSED" }), task("c", { status: "COMPLETED" }), task("d", { status: "AWAITING_AUTHORIZATION" })], details: {}, records: [rec({ kind: "task", id: "a", mode: "LIVE" }), rec({ kind: "task", id: "b", mode: "SIMULATION" })], assets: ASSETS, locale: "zh" });
  it("groups and counts", () => {
    expect(groupCounts(rows)).toEqual({ all: 4, active: 1, needs_you: 1, paused: 1, ended: 1 });
    expect(filterRows(rows, { group: "paused", mode: "all", q: "" }).map((r) => r.id)).toEqual(["b"]);
    expect(filterRows(rows, { group: "all", mode: "live", q: "" }).map((r) => r.id)).toEqual(["a"]);
    expect(filterRows(rows, { group: "all", mode: "all", q: "nvdax" })).toHaveLength(4);
    expect(filterRows(rows, { group: "all", mode: "all", q: "zzz" })).toHaveLength(0);
  });
  it("URL values are validated", () => {
    expect(parseGroup("paused")).toBe("paused");
    expect(parseGroup("DROP TABLE")).toBe("all");
    expect(parseMode("live")).toBe("live");
    expect(parseMode("x")).toBe("all");
  });
  it("delete copy says a running task is cancelled first", () => {
    expect(deleteConsequence("ACTIVE", "zh")).toContain("先取消");
    expect(deleteConsequence("COMPLETED", "zh")).not.toContain("先取消");
    expect(deleteConsequence("ACTIVE", "en")).toMatch(/cancels it first/);
  });
});

describe("v8 today", () => {
  const now = new Date("2026-10-03T12:00:00");
  const day = (h: number) => new Date(new Date("2026-10-03T00:00:00").getTime() + h * 3600_000).toISOString();
  const rows = mergeTaskRows({
    listed: [task("run", { status: "ACTIVE", updatedAt: day(9) as Task["updatedAt"] }), task("auth", { status: "AWAITING_AUTHORIZATION", updatedAt: day(-30) as Task["updatedAt"] }), task("old", { status: "COMPLETED", updatedAt: day(-48) as Task["updatedAt"] })],
    details: {}, records: [], assets: ASSETS, locale: "zh",
  });
  const item = (id: number, at: string, type: string, actor = "system", note: string | null = null): ActivityItem => ({ id, at, type, actor, note });

  it("pulls activity only for the 3 most recently updated open tasks (events go first)", () => {
    expect(PULSE_CAP).toBe(3);
    expect(PULSE_LIMIT).toBe(100);
    const { ids, coversToday } = pickPulseTasks(rows, now);
    expect(ids).toEqual(["run", "auth"]); // 最近更新的在前；已结束的 old 不拉
    expect(coversToday).toBe(true);
    expect(pickPulseTasks(rows, now, 1)).toEqual({ ids: ["run"], coversToday: true });
    expect(pickPulseTasks(rows, now, 0).coversToday).toBe(false);
    const many = mergeTaskRows({
      listed: ["a", "b", "c", "d", "e"].map((id, i) => task(id, { updatedAt: day(i) as Task["updatedAt"] })),
      details: {}, records: [], assets: ASSETS, locale: "zh",
    });
    const p = pickPulseTasks(many, now);
    expect(p.ids).toEqual(["e", "d", "c"]);
    expect(p.coversToday).toBe(false); // a、b 今天也有更新但没拉 → 今日成交写「—」
  });

  it("fills today counts on-chain confirmations only, and is unknown when a task did not load", () => {
    const pulses: Pulse[] = [{ taskId: "run", ok: true, needs: [], items: [item(1, day(-2), "step_confirmed"), item(2, day(8), "step_confirmed"), item(3, day(8), "intent_certified")] }];
    expect(fillsToday(pulses, true, now)).toBe(1);
    expect(fillsToday(pulses, false, now)).toBeNull();
    expect(fillsToday([...pulses, { taskId: "x", ok: false, items: [], needs: null }], true, now)).toBeNull();
    expect(fillsToday(null, true, now)).toBeNull(); // 活动流还没拉
  });

  it("needs come from the server's needsOwner, plus unsigned tasks without runtime", () => {
    const pulses: Pulse[] = [{ taskId: "run", ok: true, items: [], needs: [{ code: "agent_ended", blocking: true, text: { zh: "Agent 认为本任务已完成", en: "The agent considers this task done" }, action: { kind: "resume_or_cancel" } }] }];
    const list = needsList(rows, pulses, "zh");
    expect(list.map((n) => n.taskId)).toEqual(["run", "auth"]);
    expect(list[0]!.text).toBe("Agent 认为本任务已完成");
    expect(list[1]!.action.label).toBe("去签授权");
    expect(needAction("create_new_task", "x", "zh").href).toBe("/agent/new");
    expect(needAction("reclaim_allowance", "x", "en").href).toBe("/agent/funds#allowances");
    expect(needAction("top_up", "x", "zh").href).toBe(FUNDS_ALLOWANCES_HREF);
    expect(needAction("sign_permit", "tsk_1", "zh")).toEqual({ href: "/agent/tasks/tsk_1?do=delegate", label: "去签额度许可" });
    expect(needAction("confirm_revoke", "tsk_1", "zh").href).toBe("/agent/tasks/tsk_1?do=revoke");
    expect(needExternalHref("reclaim_allowance")).toBe("/agent/funds#allowances");
    expect(needExternalHref("create_new_task")).toBe("/agent/new");
    expect(needExternalHref("sign_delegation")).toBeNull();
  });

  it("available budget = remaining of ACTIVE buy authorizations; unknown when records failed", () => {
    const recs: RecordItem[] = [
      rec({ kind: "mandate", id: "m1", status: "ACTIVE", inputAssetKey: USDG, budgetCap: "10000000", spent: "2500000" }),
      rec({ kind: "mandate", id: "m2", status: "ACTIVE", inputAssetKey: AAPL, budgetCap: "999999999999", spent: "0" }),
      rec({ kind: "mandate", id: "m3", status: "COMPLETED", inputAssetKey: USDG, budgetCap: "6000000", spent: "6000000" }),
    ];
    expect(availableBudget(recs, ASSETS)).toEqual({ raw: "7500000", decimals: 6, symbol: "USDG" });
    expect(availableBudget([], ASSETS)!.raw).toBe("0");
    expect(availableBudget(null, ASSETS)).toBeNull();
  });

  it("upcoming events skip released / past ones and keep time order", () => {
    const ev = (id: string, at: string, status = "estimated") => ({ event: { id, name: id, kind: "MACRO_TIER1", status, scheduledAtUtc: at, dateLocal: at.slice(0, 10) }, relevance: "universe", rules: [], blockers: [] }) as unknown as EventDeskItem;
    const items = [ev("late", "2026-10-06T14:00:00Z"), ev("past", "2026-10-01T12:30:00Z"), ev("done", "2026-10-05T12:00:00Z", "released"), ev("soon", "2026-10-04T14:00:00Z"), ev("mid", "2026-10-05T14:00:00Z"), ev("far", "2026-10-09T14:00:00Z")];
    expect(upcomingEvents(items, now).map((i) => i.event.id)).toEqual(["soon", "mid", "late"]);
  });

  it("agent sayings quote the agent's own words, newest first, never system notes", () => {
    const pulses: Pulse[] = [{ taskId: "run", ok: true, needs: [], items: [
      item(1, day(1), "agent_declined", "agent:hosted", "Quote looks off; waiting."),
      item(2, day(2), "status", "system", "1/3 steps confirmed"),
      item(3, day(3), "agent_ended", "agent:hosted", "All three steps filled."),
    ] }];
    const s = agentSayings(pulses, rows, ASSETS, "zh");
    expect(s.map((x) => x.quote)).toEqual(["All three steps filled.", "Quote looks off; waiting."]);
    expect(s[0]!.title).toBe("两天内分两次买入 AAPLx");
  });

  it("system fallback lines are not quoted, and ISO times inside quotes are localized", () => {
    const pulses: Pulse[] = [{ taskId: "run", ok: true, needs: [], items: [
      item(1, day(1), "agent_declined", "agent:hosted", "The agent did not reach a decision within this turn's limits; nothing was traded."),
      item(2, day(2), "agent_declined", "agent:hosted", "Waiting until 2026-10-03T04:38:21.109Z for the quote."),
    ] }];
    const s = agentSayings(pulses, rows, ASSETS, "zh");
    expect(s).toHaveLength(1);
    expect(s[0]!.quote).not.toMatch(/T\d{2}:\d{2}/);
    expect(tidyQuote("at 2026-10-03T04:38:21Z", "en", now)).toMatch(/^at \d{1,2} [A-Z][a-z]{2} \d{2}:\d{2}$/);
  });

  it("simulation tasks do not block today's fill count", () => {
    const sim = mergeTaskRows({ listed: [task("sim", { updatedAt: day(9) as Task["updatedAt"] })], details: {}, records: [rec({ kind: "task", id: "sim", mode: "SIMULATION" })], assets: ASSETS, locale: "zh" });
    expect(pickPulseTasks(sim, now, 0).coversToday).toBe(true);
  });
});

describe("没拿到不当 0（审查组 B-5）", () => {
  it("records 没拿到：已用预算是 null，不是 0", () => {
    expect(spentForTask("tsk_none", "LIVE", null, ASSETS, USDG)).toBeNull();
    const rows = mergeTaskRows({ listed: [task("live", { mandateIds: ["m1"] as Task["mandateIds"] })], details: {}, records: null, assets: ASSETS, locale: "zh" });
    expect(rows[0]!.spentRaw).toBeNull();
    const ok = mergeTaskRows({ listed: [task("live", { mandateIds: ["m1"] as Task["mandateIds"] })], details: {}, records: [], assets: ASSETS, locale: "zh" });
    expect(ok[0]!.spentRaw).toBe("0");
  });
  it("没拉到活动流的暂停任务也列出来（提醒，排在阻塞项后面），链到任务页", () => {
    const rows = mergeTaskRows({ listed: [task("held", { status: "PAUSED" }), task("auth", { status: "AWAITING_AUTHORIZATION" })], details: {}, records: [], assets: ASSETS, locale: "zh" });
    const list = needsList(rows, [], "zh");
    expect(list.map((n) => [n.taskId, n.blocking])).toEqual([["auth", true], ["held", false]]);
    expect(list[1]!.action).toEqual({ href: "/agent/tasks/held?do=decide", label: "决定继续或取消" });
  });
});
