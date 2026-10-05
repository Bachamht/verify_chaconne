import { describe, expect, it } from "vitest";
import day from "./fixtures/recap-agent-day.json";
import type { RecapView } from "@/lib/api-v2";
import type { AssetLite } from "@/lib/activityText";
import { buildReceipts, dayText, decisionHref, decisionState, decisionText, fillCounts, quoteLabel, revocableMeta, shiftTradingDay, type Receipt, type Revocable } from "@/components/features/journal/receipts";
import { CONDITION_LABEL, sourceCount, vixInvalid, actionErrorText, compareRows, conditionLabel, diffLabel, gapLabel, outcomeMeta, replayCounts, sideText, snapshotSummary, spanPct, tabFromLegacy } from "@/components/features/lab/labText";
import { variantItems, DEFAULT_A } from "@/components/features/lab/VariantEditor";

const ASSETS: AssetLite[] = [
  { assetKey: "eip155:196:0x4ae46a509f6b1d9056937ba4500cb143933d2dc8", tokenAddress: "0x4ae46a509f6b1d9056937ba4500cb143933d2dc8", tokenDecimals: 6, displaySymbol: "USDG", role: "stable_input" },
  { assetKey: "eip155:196:0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a", tokenAddress: "0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a", tokenDecimals: 18, displaySymbol: "AAPLx", role: "stock_output" },
  { assetKey: "eip155:196:0xc845b2894dbddd03858fd2d643b4ef725fe0849d", tokenAddress: "0xc845b2894dbddd03858fd2d643b4ef725fe0849d", tokenDecimals: 18, displaySymbol: "NVDAx", role: "stock_output" },
];
const recap = day as unknown as Pick<RecapView, "sections" | "agent">;
const RAW = /\b[a-z]+_[a-z_]+\b|\b[A-Z]+_[A-Z_]+\b|0x[0-9a-f]{6,}|(?<![.\d])\d{6,}\b|\bmnd_|\bint_|\btsk_|T\d{2}:\d{2}:\d{2}/;

describe("journal receipts (real 2026-10-02 recap of the demo wallet)", () => {
  for (const locale of ["zh", "en"] as const) {
    const rs = buildReceipts(recap, { locale, assets: ASSETS });
    it(`${locale}: action and change sentences carry no raw codes, ids, ISO or minimal units`, () => {
      expect(rs.length).toBeGreaterThan(5);
      for (const r of rs) {
        expect(r.action, r.action).not.toMatch(RAW);
        expect(r.changed, r.changed).not.toMatch(RAW);
      }
    });
  }
  const zh = buildReceipts(recap, { locale: "zh", assets: ASSETS });
  it("newest first", () => {
    for (let i = 1; i < zh.length; i++) expect(Date.parse(zh[i - 1]!.at)).toBeGreaterThanOrEqual(Date.parse(zh[i]!.at));
  });
  it("chinese page: system english never appears outside agent quotes", () => {
    for (const r of zh) expect(`${r.action}${r.changed}`).not.toMatch(/\b(no response|nothing was done|certified|confirmed|turn \d+|raw)\b/i);
  });
  it("fills are final, carry the tx and the stock bought in human units", () => {
    const fills = zh.filter((r) => r.kind === "fill");
    expect(fills).toHaveLength(3);
    for (const f of fills) {
      expect(f.revocable).toBe<Revocable>("no");
      expect(f.evidence.kind).toBe("tx");
      expect(f.evidence.value).toMatch(/^0x[0-9a-f]{64}$/);
    }
    expect(fills.some((f) => /^买入 0\.00\d+ AAPLx$/.test(f.changed))).toBe(true);
  });
  it("certified intents are not fills and say how to stop them", () => {
    const c = zh.filter((r) => r.kind === "certified");
    expect(c.length).toBeGreaterThan(0);
    for (const r of c) {
      expect(r.revocable).toBe("onchain");
      expect(r.changed).toContain("签发不等于成交");
    }
    expect(revocableMeta("onchain", "zh").hint).toContain("链上撤销");
  });
  it("agent declines keep the agent's own words and its next-step condition, without duplicates from waits", () => {
    const d = zh.filter((r) => r.kind === "declined");
    expect(d).toHaveLength(3);
    for (const r of d) {
      expect(r.quote).toBeTruthy();
      expect(r.nextIf).toBeTruthy();
      expect(r.revocable).toBe("none");
    }
  });
  it("system no-response waits are merged per task, with a chinese sentence and no quote", () => {
    const s = zh.filter((r) => r.kind === "no_response");
    expect(s.length).toBeGreaterThan(0);
    expect(s.reduce((n, r) => n + r.count, 0)).toBe(8);
    for (const r of s) {
      expect(r.quote).toBeNull();
      expect(r.action).toMatch(/^Agent (有 \d+ 轮|这一轮)没有回应$/);
    }
  });
  it("quote labels mark agent words, and flag untranslated english on the chinese page", () => {
    expect(quoteLabel("Strategy caps buys at one per hour.", "zh")).toBe("Agent 原话（英文原文，未翻译）");
    expect(quoteLabel("每小时最多买一次", "zh")).toBe("Agent 原话");
    expect(quoteLabel("x", "en", "nextIf")).toBe("Agent's own words · when it would act");
  });
  it("decisions: unmapped codes get local text and a destination", () => {
    expect(decisionText("CANCELLED_OFFCHAIN", "zh")).toContain("链上撤销");
    // 链上撤销在任务页做；只有收回额度才去资金页（审查组 B-1）
    expect(decisionHref({ action: "revoke", refId: "tsk_9" })).toBe("/agent/tasks/tsk_9?do=revoke");
    expect(decisionHref({ action: "revoke", refId: "mnd_1" })).toBe("/tasks/mnd_1?do=revoke");
    expect(decisionHref({ action: "authorize", refId: "tsk_9" })).toBe("/agent/tasks/tsk_9?do=delegate");
    expect(decisionHref({ action: "reclaim", refId: "tsk_9" })).toBe("/agent/funds#allowances");
    expect(revocableMeta("onchain", "zh").hint).toContain("任务页");
    expect(revocableMeta("onchain", "zh").hint).not.toContain("资金");
    expect(decisionText("CANCELLED_OFFCHAIN", "zh")).not.toContain("资金");
    expect(decisionHref({ action: "review", refId: "tsk_1" })).toBe("/agent/tasks/tsk_1");
    expect(decisionHref({ action: "resume", refId: "tsk_1" })).toBe("/agent/tasks/tsk_1?do=decide");
  });
  it("decisions are checked against the live task state (journal is a snapshot)", () => {
    const live = new Map([["tsk_p", "PAUSED"], ["tsk_c", "CANCELLED"], ["tsk_r", "REVOKED"], ["tsk_a", "ACTIVE"]]);
    expect(decisionState({ action: "resume", refId: "tsk_p" }, live)).toBe("open");
    expect(decisionState({ action: "resume", refId: "tsk_a" }, live)).toBe("done");
    expect(decisionState({ action: "revoke", refId: "tsk_c" }, live)).toBe("open");
    expect(decisionState({ action: "revoke", refId: "tsk_r" }, live)).toBe("done");
    expect(decisionState({ action: "review", refId: "tsk_c" }, live)).toBe("done");
    expect(decisionState({ action: "review", refId: "tsk_gone" }, live)).toBe("deleted");
    expect(decisionState({ action: "revoke", refId: "mnd_1" }, live)).toBe("open");
    expect(decisionState({ action: "review", refId: "tsk_gone" }, null)).toBe("open");
  });
  it("trading-day paging skips weekends", () => {
    expect(shiftTradingDay("2026-10-02", 1)).toBe("2026-10-05");
    expect(shiftTradingDay("2026-10-05", -1)).toBe("2026-10-02");
    expect(shiftTradingDay("bad", 1)).toBe("bad");
  });
});

describe("lab text", () => {
  it("legacy anchors map to tabs; ?tab= wins", () => {
    expect(tabFromLegacy("#compare", null)).toBe("compare");
    expect(tabFromLegacy("#replay", null)).toBe("replay");
    expect(tabFromLegacy("#wait", null)).toBe("diagnose");
    expect(tabFromLegacy("#compare", "replay")).toBe("replay");
    expect(tabFromLegacy(null, "nope")).toBe("diagnose");
  });
  it("every condition type has zh and en labels; unknown types never leak", () => {
    for (const [k, v] of Object.entries(CONDITION_LABEL)) {
      expect(v.zh, k).not.toMatch(/_/);
      expect(v.en, k).not.toMatch(/_/);
    }
    expect(conditionLabel("something_new", "zh")).toBe("其它条件");
  });
  it("outcomes and gaps are localized", () => {
    expect(outcomeMeta("SATISFIED", "zh")).toEqual({ label: "放行", tone: "ok" });
    expect(outcomeMeta("WHATEVER", "en").label).toBe("Unknown");
    expect(gapLabel("NO_QUOTE", "zh")).toBe("没有报价");
    expect(gapLabel("NEW_REASON", "zh")).toBe("数据缺口");
  });
  it("four-column comparison rows: outcome, blockers, next check, planner, then condition diff", () => {
    const rows = compareRows({
      outcomeDiff: [{ label: "A", outcome: "SATISFIED", blockingCodes: [], nextCheckAt: null }, { label: "B", outcome: "UNSATISFIED", blockingCodes: ["EVENT_WINDOW_ACTIVE"], nextCheckAt: "2026-10-03T14:00:00Z" }],
      comparison: { diff: [{ itemType: "avoid_event_window", a: variantItems(DEFAULT_A)[1], b: null }, { itemType: "max_vix", a: null, b: { type: "max_vix", value: 30 } }] },
      planner: [{ summary: { candidateCount: 2, verdict: null } }, { summary: null }],
    }, "zh", (iso) => `t(${iso.slice(11, 16)})`, (c) => `原因:${c}`);
    expect(rows.map((r) => r.key)).toEqual(["outcome", "blockers", "next", "planner", "item:avoid_event_window", "item:max_vix"]);
    expect(rows[0]).toMatchObject({ a: "放行", b: "等待", diff: "differs" });
    expect(rows[2]).toMatchObject({ a: "未知", b: "t(14:00)" });
    expect(rows[3]).toMatchObject({ a: "2 个候选", b: "不可用" });
    expect(rows[4]).toMatchObject({ field: "事件回避窗口", b: "无此项", diff: "only_a" });
    expect(rows[5]).toMatchObject({ field: "VIX 上限", diff: "only_b" });
    expect(diffLabel("same", "zh").label).toBe("相同");
  });
  it("side text never dumps JSON", () => {
    expect(sideText({ foo: 1 }, "zh")).not.toContain("{");
    expect(sideText(undefined, "en")).toBe("Not set");
  });
  it("snapshot summary, replay counts and bar geometry", () => {
    expect(snapshotSummary({ eventVersions: [1, 2, 3], evidenceIds: new Array(7) }, "zh")).toBe("3 个事件版本 · 7 条证据");
    expect(replayCounts([{ outcome: "SATISFIED" }, { outcome: "UNSATISFIED" }, { outcome: "UNSATISFIED" }])).toEqual({ SATISFIED: 1, UNSATISFIED: 2, INSUFFICIENT_EVIDENCE: 0 });
    const g = spanPct("2026-10-01T06:00:00Z", "2026-10-01T12:00:00Z", "2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z");
    expect(g.x).toBeCloseTo(25);
    expect(g.w).toBeCloseTo(25);
    expect(spanPct("2026-09-30T00:00:00Z", "2026-09-30T00:00:00Z", "2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z").w).toBeGreaterThan(0);
  });
  it("POST refusals (e.g. read-only relay 403) read as a sentence, not a raw code", () => {
    const t = actionErrorText({ status: 403, data: { error: "relay_read_only" } }, "zh");
    expect(t).toContain("只读");
    expect(t).not.toMatch(/_/);
    expect(actionErrorText({ status: 418, data: { error: "some_new_code" } }, "en")).not.toMatch(/_/);
  });
});

describe("审查组 B：日志与实验", () => {
  it("交易日不直出 ISO", () => {
    expect(dayText("2026-10-02", "zh")).toBe("10月2日 周五");
    expect(dayText("2026-10-02", "en")).toBe("Fri, Oct 2");
    expect(dayText("bad", "zh")).toBe("日期未返回");
  });
  it("链上成交数与回执列表同口径（含旧式授权计划成交）", () => {
    const r = (kind: Receipt["kind"]): Receipt => ({ id: kind, at: "2026-10-02T15:00:00Z", taskId: null, kind, action: "", changed: "", tone: "ok", evidence: { kind: "none", value: null }, revocable: "none", quote: null, nextIf: null, count: 1 });
    expect(fillCounts([r("fill"), r("fill"), r("fill"), r("certified")], [{ side: "buy" }, { side: "sell" }])).toEqual({ total: 3, buy: 1, sell: 1, legacy: 1 });
  });
  it("VIX 上限：空 = 不限；非正数 / 非数字无效", () => {
    expect(vixInvalid("")).toBe(false);
    expect(vixInvalid("25")).toBe(false);
    expect(vixInvalid("0")).toBe(true);
    expect(vixInvalid("abc")).toBe(true);
  });
  it("回放数据量缺值写未返回，不补 0", () => {
    expect(sourceCount(3, "zh")).toBe("3");
    expect(sourceCount(0, "zh")).toBe("0");
    expect(sourceCount(undefined, "zh")).toBe("未返回");
  });
});
