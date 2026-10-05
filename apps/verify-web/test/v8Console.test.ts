import { describe, expect, it } from "vitest";
import type { TaskRuntime } from "@chaconne/core/verify";
import { presenceText } from "@/lib/presenceText";
import { consoleStatus, primaryAction, spentRaw, stepTimeline, visibleNextCheck } from "@/components/features/task-console/consoleModel";

const rt = (over: Partial<TaskRuntime> = {}): TaskRuntime => ({ agentMode: "hosted", executorMode: "hosted", presence: { mode: "hosted", state: "waiting", currentActivity: null, waitingFor: null, lastDecisionAt: null, nextCheckAt: "2026-10-03T05:00:00Z" }, executor: null, needsOwner: [], needsOperator: [], ...over } as unknown as TaskRuntime);
const base = { status: "ACTIVE", mode: "LIVE" as const, runtime: rt(), delegationComplete: true, plannedSteps: 3, fills: [] };

describe("v8 console model", () => {
  it("status mapping and control availability", () => {
    expect(consoleStatus({ status: "PARTIAL", mode: "LIVE" })).toMatchObject({ status: "running", mode: "live", stoppable: true, paused: false, terminal: false });
    expect(consoleStatus({ status: "PAUSED", mode: "SIMULATION" })).toMatchObject({ status: "paused", mode: "simulation", stoppable: false, paused: true });
    expect(consoleStatus({ status: "COMPLETED", mode: null })).toMatchObject({ terminal: true, mode: null });
  });
  it("primary action: delegation first, then resume, otherwise none", () => {
    expect(primaryAction({ ...base, delegationComplete: false })).toBe("delegate");
    expect(primaryAction({ ...base, runtime: rt({ needsOwner: [{ code: "delegation_incomplete", blocking: true, text: { zh: "", en: "" }, action: { kind: "sign_delegation" } }] as never }) })).toBe("delegate");
    expect(primaryAction({ ...base, status: "PAUSED" })).toBe("resume");
    expect(primaryAction(base)).toBeNull();
    // 观察任务从不要求委托
    expect(primaryAction({ ...base, mode: "SIMULATION", delegationComplete: false })).toBeNull();
  });
  it("only on-chain confirmation counts as done; a sent step is active", () => {
    const fills = [
      { mandateId: "m1", stepIndex: "0", state: "CONFIRMED", txHash: "0xa", spent: "2000000" },
      { mandateId: "m1", stepIndex: "1", state: "SUBMITTED", txHash: "0xb", spent: null },
      { mandateId: "m2", stepIndex: "0", state: "CONFIRMED", txHash: "0xc", spent: null },
    ];
    expect(stepTimeline(3, fills, "m1", true).map((s) => s.state)).toEqual(["done", "active", "idle"]);
    expect(stepTimeline(3, [fills[0]!], "m1", true).map((s) => s.state)).toEqual(["done", "active", "idle"]);
    expect(stepTimeline(3, [fills[0]!], "m1", false).map((s) => s.state)).toEqual(["done", "idle", "idle"]);
    expect(stepTimeline(null, fills, "m1", true)).toEqual([]);
  });
  it("paused and finished tasks never show a next check", () => {
    expect(visibleNextCheck({ status: "ACTIVE", runtime: rt() }, null)).toBe("2026-10-03T05:00:00Z");
    expect(visibleNextCheck({ status: "PAUSED", runtime: rt() }, "2026-10-03T06:00:00Z")).toBeNull();
    expect(visibleNextCheck({ status: "COMPLETED", runtime: rt() }, "2026-10-03T06:00:00Z")).toBeNull();
    expect(visibleNextCheck({ status: "WAITING", runtime: null }, "2026-10-03T06:00:00Z")).toBe("2026-10-03T06:00:00Z");
  });
  it("spent: mandate value first, then confirmed fills, never a made-up zero", () => {
    expect(spentRaw([{ mandateId: "m1", state: "ACTIVE", current: true, spent: "6000000" }], [])).toBe("6000000");
    expect(spentRaw([], [{ mandateId: "m", stepIndex: "0", state: "CONFIRMED", txHash: null, spent: "2000000" }, { mandateId: "m", stepIndex: "1", state: "CONFIRMED", txHash: null, spent: "1500000" }])).toBe("3500000");
    expect(spentRaw(undefined, [])).toBeNull();
  });
});

describe("presence text (server phrases are English only)", () => {
  it("translates known phrases on Chinese pages and never shows unknown English there", () => {
    expect(presenceText("reading the task context", "zh")).toBe("读取任务上下文");
    expect(presenceText("checking executable quotes", "zh")).toBe("查询可成交报价");
    expect(presenceText("some new server phrase", "zh")).toBeNull();
    expect(presenceText("some new server phrase", "en")).toBe("some new server phrase");
    expect(presenceText("waiting on: MARKET_OUTSIDE_REGULAR", "zh")).toMatch(/^在等：美股/);
    expect(presenceText("waiting on: BRAND_NEW_CODE", "zh")).toBe("在等：另一项条件");
    expect(presenceText("next check at 2026-10-05T13:30:00.000Z", "zh")).toMatch(/^下次检查 \d{2}\/\d{2} \d{2}:\d{2}$/);
    expect(presenceText(null, "zh")).toBeNull();
  });
});
