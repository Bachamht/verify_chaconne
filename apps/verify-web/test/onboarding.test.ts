import { describe, expect, it } from "vitest";
import type { AssetEntry } from "../lib/assets";
import { COMPLEX_TASKS } from "../components/agent/home/entries";
import { buildGoalRequest, isSimulationTask, liveGoalDraft, simulationDecision, splitSimulationBudget, type SimulationTask } from "../components/onboarding/model";

const OWNER = "0xbacb0000000000000000000000000000000f0381";
const stable: AssetEntry = { assetKey: "eip155:196:0x4ae46a509f6b1d9056937ba4500cb143933d2dc8", tokenAddress: "0x4ae46a509f6b1d9056937ba4500cb143933d2dc8", tokenDecimals: 6, displaySymbol: "USDG", underlyingId: "fiat:USD", role: "stable_input", executionAllowed: true };
const stock: AssetEntry = { assetKey: "eip155:196:0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a", tokenAddress: "0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a", tokenDecimals: 18, displaySymbol: "AAPLx", underlyingId: "NASDAQ:AAPL", role: "stock_output", executionAllowed: true };
const stock2: AssetEntry = { ...stock, assetKey: "eip155:196:0x1111111111111111111111111111111111111111", tokenAddress: "0x1111111111111111111111111111111111111111", displaySymbol: "TSLAx", underlyingId: "NASDAQ:TSLA" };
function view(status = "ACTIVE", outcome?: string, wouldIssue?: boolean, hasBlocker = false): SimulationTask {
  return { mode: "SIMULATION", task: { id: "tsk_test", status, conditions: { version: "conditions/1", items: [], hash: "test" }, blockers: hasBlocker ? [{ code: "market_closed" }] : [] }, lastEvaluation: outcome ? { outcome, simulation: { wouldIssue } } : null, mandateDraft: null, thesisDraft: null, budgetAllocation: null } as unknown as SimulationTask;
}

describe("New visitor budget caps", () => {
  it("uses integer base units and rounds down without expanding the user's total", () => {
    expect(splitSimulationBudget("1", 6, 3)).toEqual({ requestedRaw: "1000000", perStepRaw: "333333", totalRaw: "999999", remainderRaw: "1", perStepHuman: "0.333333" });
    expect(splitSimulationBudget("10", 0, 3)?.perStepHuman).toBe("3");
  });
  it.each(["", "-1", "NaN", "1e3", "0", "0.000001", "1.0000001", "1,000", "Infinity"])("rejects an invalid or unsplittable total: %s", (input) => {
    expect(splitSimulationBudget(input, 6, 3)).toBeNull();
  });
});

describe("Complex tasks are goal tasks (no template, no rules)", () => {
  it("five distinct tasks with objective, strategy, watch kinds and a sample intent in both languages", () => {
    expect(new Set(COMPLEX_TASKS.map((t) => t.id)).size).toBe(5);
    for (const t of COMPLEX_TASKS) {
      for (const l of ["zh", "en"] as const) { expect(t.objective[l].length).toBeGreaterThan(10); expect(t.strategy[l].length).toBeGreaterThan(40); expect(t.sampleIntent.rationale[l]).toBeTruthy(); }
      expect(t.watch.length).toBeGreaterThan(0);
      expect(t.steps).toBeGreaterThanOrEqual(4);
    }
  });
  it.each(COMPLEX_TASKS)("$id → SIMULATION goal request without playbookId; scope carries assets / caps / steps / trust; strategy and watch ride along", (task) => {
    const stocks = [stock, stock2].slice(0, task.assets);
    const r = buildGoalRequest(task, stocks, stable, "100", OWNER, "t-1", "zh")!;
    expect(r).not.toHaveProperty("playbookId");
    expect(r.mode).toBe("SIMULATION");
    expect(r.ownerAddress).toBe(OWNER);
    expect(r.scope).toMatchObject({ objective: task.objective.zh, inputAssetKey: stable.assetKey, outputAssetKeys: stocks.map((s) => s.assetKey), budgetCapRaw: String(BigInt(100_000_000n / BigInt(task.steps)) * BigInt(task.steps)), maxSteps: task.steps, trustTier: task.trustTier, issuance: "agent" });
    expect(BigInt(String(r.scope!.perStepCapRaw)) * BigInt(task.steps)).toBeLessThanOrEqual(100_000_000n);
    expect(r.strategy).toBe(task.strategy.zh);
    expect(r.watchEvents).toEqual({ kinds: task.watch });
    expect(r.exampleId).toBe(task.id);
    if (task.regularSessionOnly) expect(r.scope!.hardConditions).toEqual([{ type: "session", allow: ["US_REGULAR"] }]);
    else expect(r.scope!.hardConditions).toBeUndefined();
    expect(r.conditions).toBeUndefined();
  });
  it("never without a connected wallet, never with a non-executable asset", () => {
    expect(buildGoalRequest(COMPLEX_TASKS[0]!, [stock], stable, "100", null, "t", "zh")).toBeNull();
    expect(buildGoalRequest(COMPLEX_TASKS[0]!, [{ ...stock, executionAllowed: false }], stable, "100", OWNER, "t", "zh")).toBeNull();
    expect(buildGoalRequest(COMPLEX_TASKS[0]!, [], stable, "100", OWNER, "t", "zh")).toBeNull();
  });
  it("live handoff keeps objective, strategy, assets and caps in human units; no owner, no request id", () => {
    const task = COMPLEX_TASKS[1]!;
    const r = buildGoalRequest(task, [stock, stock2], stable, "300", OWNER, "t-2", "en")!;
    const d = liveGoalDraft(r, task, stable, "300")!;
    expect(d).toMatchObject({ objective: task.objective.en, strategy: task.strategy.en, assetKeys: [stock.assetKey, stock2.assetKey], inputAssetKey: stable.assetKey, totalHuman: "300", perStepHuman: "50", maxSteps: task.steps, days: task.days, trustTier: task.trustTier, watch: task.watch, exampleId: task.id });
    expect(JSON.stringify(d)).not.toMatch(/ownerAddress|clientRequestId/);
  });
});

describe("Honest simulation results", () => {
  it("requires explicit simulation mode in API responses", () => {
    expect(isSimulationTask(view())).toBe(true);
    expect(isSimulationTask({ ...view(), mode: "LIVE" })).toBe(false);
    expect(isSimulationTask({ mode: "SIMULATION", task: {} })).toBe(false);
  });
  it("does not mistake missing evidence or an empty blocker list for a pass", () => {
    expect(simulationDecision(view())).toBe("unknown");
    expect(simulationDecision(view("ACTIVE", "UNSATISFIED", false))).toBe("waiting");
    expect(simulationDecision(view("ACTIVE", "SATISFIED", true, true))).toBe("waiting");
    expect(simulationDecision(view("ACTIVE", "SATISFIED", true))).toBe("ready");
    expect(simulationDecision(view("PAUSED", "SATISFIED", true))).toBe("stopped");
  });
});
