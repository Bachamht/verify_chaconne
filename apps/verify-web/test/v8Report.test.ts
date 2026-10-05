import { describe, expect, it } from "vitest";
import { EXECUTION_STATES, MANDATE_STEP_STATES } from "@chaconne/core/verify";
import fixture from "./fixtures/report-live-job.json";
import {
  bpsPercent, comparisonText, confirmationsText, reportVersionText, evidenceKindText, evidenceValue, execStateText, execStateToneV8, orderStateText, policyLabel, policyNote, POLICY_IDS,
  reasonOverride, referenceKindText, sessionText, severityLevel, tradingDateText, verdictHeadline, verdictKind, verdictTag,
} from "@/components/features/report/labels";
import { billRows, tickerOf, unitOf, type AssetLite } from "@/components/features/report/model";
import { toBlockerItems } from "@/components/features/report/ReasonList";
import { controlCopy } from "@/components/features/common/controlCopy";
import { MANDATE_EVAL, NEXT_STEP, toolsCopy } from "@/components/features/tools/copy";
import { evaluationsOf, taskNumbers } from "@/components/features/tools/taskModel";
import type { MandateView } from "@/lib/api-v2";
import type { Bill } from "@chaconne/core/verify";

const SNAKE = /[A-Z]{2,}_[A-Z]/;
const assets = fixture.assets as AssetLite[];
const both = (fn: (l: "zh" | "en") => string | null) => [fn("zh"), fn("en")];

describe("report labels: every enum has zh/en copy, no SNAKE_CASE leaks", () => {
  it("execution and mandate-step states", () => {
    for (const s of [...EXECUTION_STATES, ...MANDATE_STEP_STATES]) {
      for (const t of both((l) => execStateText(s, l))) {
        expect(t).toBeTruthy();
        expect(t).not.toMatch(SNAKE);
        expect(t).not.toMatch(/未知|Unknown state/);
      }
    }
    expect(execStateToneV8("CONFIRMED")).toBe("ok");
    expect(execStateToneV8("REVERTED")).toBe("bad");
    // 广播不等于成交：SUBMITTED 不能是 ok 色
    expect(execStateToneV8("SUBMITTED")).not.toBe("ok");
  });
  it("reference kinds, comparison, sessions, order states, policies", () => {
    for (const k of ["live", "official_close", "close_cross_verified", "provisional_close", "last_regular_observation", "close_last_tick"]) expect(referenceKindText(k, "zh")).not.toBe("参考价");
    for (const c of ["live", "official_close", "unverified", "not_requested"]) expect(comparisonText(c, "zh")).not.toBe("未比较");
    for (const s of ["REGULAR", "PRE", "POST", "CLOSED", "HOLIDAY"]) expect(sessionText(s, "en")).not.toBe("Session unknown");
    for (const o of ["PAYMENT_REQUIRED", "REPORT_READY", "PAID", "SETTLEMENT_PENDING", "DELIVERED"]) expect(orderStateText(o, "zh")).not.toBe("处理中");
    for (const p of POLICY_IDS) {
      expect(policyLabel(p, "zh")).not.toMatch(SNAKE);
      expect(policyNote(p, "en")).toBeTruthy();
    }
  });
  it("every evidence kind in the live sample has a human name and a value without raw units", () => {
    for (const e of fixture.report.evidence) {
      expect(evidenceKindText(e.payload.kind, "zh")).not.toBe("其它证据");
      const v = evidenceValue(e.payload as Record<string, unknown>);
      expect(v).not.toBeNull();
    }
    expect(evidenceValue({ kind: "okx_quote", expectedOutRaw: "14755590322772605" })).toEqual({ kind: "out", raw: "14755590322772605" });
    expect(evidenceValue({ kind: "ref_close", closeUsd: "338.98" })).toEqual({ kind: "usd", value: "338.98" });
  });
  it("lib/reasons copy that embeds an enum is overridden on the report", () => {
    expect(reasonOverride("COMPARISON_NOT_REQUESTED", "zh")).not.toMatch(SNAKE);
    expect(reasonOverride("COMPARISON_NOT_REQUESTED", "en")).not.toMatch(SNAKE);
  });
});

describe("report verdict and numbers", () => {
  it("verdictKind follows the saved report, never claims an old quote is executable", () => {
    expect(verdictKind(fixture.report.report)).toBe("passed");
    expect(verdictKind({ verdict: "rejected", executionEligible: false, reasons: fixture.rejectedReasons })).toBe("blocked");
    expect(verdictKind({ verdict: "eligible", executionEligible: true, reasons: [{ code: "QUOTE_TOO_OLD", severity: "block" }] })).toBe("expired");
    expect(verdictKind({ verdict: "limited", executionEligible: false, reasons: [] })).toBe("limited");
    expect(verdictKind(null)).toBe("none");
    for (const k of ["passed", "blocked", "limited", "expired", "none"] as const) expect(verdictHeadline(k, "zh")).not.toMatch(/——/);
    expect(verdictTag("eligible", "zh")).toBe("可执行");
  });
  it("bps → percent without inventing zero", () => {
    expect(bpsPercent(-4)).toBe("-0.04%");
    expect(bpsPercent(7, false)).toBe("0.07%");
    expect(bpsPercent(12)).toBe("+0.12%");
    expect(bpsPercent(null)).toBeNull();
  });
  it("trading date is shown as a date, not ISO", () => {
    expect(tradingDateText("2026-09-21", "zh")).toBe("2026年9月21日");
    expect(tradingDateText("2026-09-21", "en")).toBe("Sep 21, 2026");
    expect(tradingDateText("bad", "en")).toBeNull();
  });
  it("unit lookup by asset key or token address; unknown stays unknown", () => {
    expect(unitOf(assets, fixture.job.job.inputAssetKey)).toEqual({ decimals: 6, symbol: "USDG" });
    expect(unitOf(assets, "0x4ae46a509f6b1d9056937ba4500cb143933d2dc8").symbol).toBe("USDG");
    expect(unitOf(assets, "0xdeadbeef")).toEqual({ decimals: null, symbol: null });
    expect(tickerOf("us-equity:AAPL")).toBe("AAPL");
  });
  it("reasons are graded by the report's severity and de-duplicated", () => {
    const items = toBlockerItems(fixture.rejectedReasons, "zh");
    expect(items.map((i) => i.code)).toEqual(["MARKET_OUTSIDE_REGULAR", "REFERENCE_STALE"]);
    expect(items.every((i) => i.level === "block")).toBe(true);
    expect(severityLevel("warning")).toBe("warn");
    expect(severityLevel("info")).toBe("wait");
  });
});

describe("bill rows (V-37: no raw units on the page)", () => {
  it("free fee row from the live sample", () => {
    const rows = billRows(fixture.bill.bill as Bill, assets, "zh");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.label).toBe("核验服务费（本次免费）");
    expect(rows[0]!.free).toBe(true);
    expect(rows[0]!.label).not.toMatch(/verify_once/);
  });
  it("principal resolves token address → decimals + symbol; gas is units; labels hide attempt ids", () => {
    const rows = billRows(fixture.billConfirmed.bill as Bill, assets, "en");
    const p = rows.find((r) => r.group === "principal")!;
    expect(p.label).toBe("Principal spent");
    expect(p.amount).toEqual({ kind: "token", raw: "5000000", decimals: 6, symbol: "USDG" });
    const g = rows.find((r) => r.group === "gas")!;
    expect(g.amount).toEqual({ kind: "units", value: "551153" });
    for (const r of rows) expect(r.label).not.toMatch(/exe_|execution|gasUsed/);
  });
});



describe("tools copy", () => {
  it("zh and en have the same keys and no em-dash pairs", () => {
    const zh = toolsCopy("zh");
    const en = toolsCopy("en");
    expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
    for (const v of Object.values(zh)) if (typeof v === "string") expect(v).not.toMatch(/——/);
  });
  it("mandate numbers survive the live response shape (budget.cap, mandate.perStepCap, ISO deadline, no evaluations)", () => {
    const live = { mandateId: "mnd_x", spent: "2000000", budget: { cap: "2000000", spent: "2000000" }, deadline: "2026-10-05T04:34:00.000Z", mandate: { perStepCap: "1000000", budgetCap: "2000000" } } as unknown as MandateView;
    expect(taskNumbers(live)).toEqual({ budgetCap: "2000000", perStepCap: "1000000", spent: "2000000", deadline: "2026-10-05T04:34:00.000Z", policyId: null });
    expect(evaluationsOf(live)).toEqual([]);
  });
  it("plan next steps and mandate evaluations are mapped", () => {
    for (const k of ["READY", "ACCEPT_PARTIAL", "SWITCH_INPUT", "WAIT_CONDITION", "PROVIDE_DATA", "USER_MUST_RELAX_LIMIT"]) expect(NEXT_STEP[k]?.zh).toBeTruthy();
    for (const k of ["READY", "WAIT", "BLOCKED", "DONE"]) expect(MANDATE_EVAL[k]?.en).toBeTruthy();
  });
});

describe("review round 1 (group A) fixes", () => {
  it("missing report version / confirmations say not returned, never v1 or 0", () => {
    expect(reportVersionText(undefined)).toBeNull();
    expect(reportVersionText(3)).toBe("v3");
    expect(confirmationsText(null, 12, "zh")).toBe("确认数未返回");
    expect(confirmationsText(4, undefined, "en")).toBe("Confirmations not returned");
    expect(confirmationsText(0, 12, "zh")).toBe("已确认 0 / 12 个区块");
  });
  it("pause / cancel / revoke copy is one shared source with the accurate semantics", () => {
    for (const zh of [true, false]) for (const op of ["pause", "cancel", "revoke"] as const) {
      const c = controlCopy(op, zh);
      expect(c.title && c.body && c.label && c.done).toBeTruthy();
      expect(c.body).not.toMatch(/——/);
    }
    expect(controlCopy("revoke", true).body).toMatch(/签名并发送的交易.*gas.*不会收回代币额度/);
    expect(controlCopy("pause", true).body).toMatch(/链上额度不变/);
    expect(controlCopy("cancel", true).body).toMatch(/已取走的证书在到期前仍可能被执行/);
    expect(controlCopy("pause", true, { hostedExecutor: true }).body).toMatch(/平台执行/);
    expect(controlCopy("revoke", true, { revokeAlsoCancels: true }).body).toMatch(/任务同时标为取消/);
  });
  it("one policy / session map: public and report agree", () => {
    expect(policyLabel("REFERENCE_CONTEXT", "zh")).toBe("参考收盘价");
    expect(policyLabel("QUOTE_ONLY", "zh")).toBe("只核对报价");
    expect(sessionText("WEIRD", "zh")).toBe("时段未知");
  });
});
