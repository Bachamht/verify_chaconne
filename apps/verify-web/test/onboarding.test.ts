import { describe, expect, it } from "vitest";
import type { AssetEntry } from "../lib/assets";
import { SAMPLES } from "../components/agent/home/entries";
import { presetFromDraft } from "../components/agent/tasks/taskDraft";
import { buildSimulationRequest, isSimulationTask, liveDraftFromSimulation, simulationDecision, splitSimulationBudget, type SimulationTask } from "../components/onboarding/model";

const OWNER = "0xbacb0000000000000000000000000000000f0381";

const stable: AssetEntry = { assetKey: "eip155:196:0x4ae46a509f6b1d9056937ba4500cb143933d2dc8", tokenAddress: "0x4ae46a509f6b1d9056937ba4500cb143933d2dc8", tokenDecimals: 6, displaySymbol: "USDG", underlyingId: "fiat:USD", role: "stable_input", executionAllowed: true };
const stock: AssetEntry = { assetKey: "eip155:196:0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a", tokenAddress: "0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a", tokenDecimals: 18, displaySymbol: "AAPLx", underlyingId: "NASDAQ:AAPL", role: "stock_output", executionAllowed: true };
function view(status = "ACTIVE", outcome?: string, wouldIssue?: boolean, hasBlocker = false): SimulationTask {
  return {
    mode: "SIMULATION",
    task: { id: "tsk_test", status, conditions: { version: "conditions/1", items: [], hash: "test" }, blockers: hasBlocker ? [{ code: "market_closed" }] : [] },
    lastEvaluation: outcome ? { outcome, simulation: { wouldIssue } } : null,
    mandateDraft: null, thesisDraft: null, budgetAllocation: null,
  } as unknown as SimulationTask;
}

describe("New visitor budget caps", () => {
  it("uses integer base units and rounds down without expanding the user's total", () => {
    expect(splitSimulationBudget("1", 6, 3)).toEqual({ requestedRaw: "1000000", perStepRaw: "333333", totalRaw: "999999", remainderRaw: "1", perStepHuman: "0.333333" });
    const large = splitSimulationBudget("9007199254740993.01", 6, 3)!;
    expect(BigInt(large.totalRaw) + BigInt(large.remainderRaw)).toBe(9007199254740993010000n);
    expect(splitSimulationBudget("10", 0, 3)?.perStepHuman).toBe("3");
    expect(splitSimulationBudget("1", 18, 3)?.perStepHuman).toBe("0.333333333333333333");
  });
  it.each(["", "-1", "NaN", "1e3", "0", "0.000001", "1.0000001", "1,000", "Infinity"])("rejects an invalid or unsplittable total: %s", (input) => {
    expect(splitSimulationBudget(input, 6, 3)).toBeNull();
  });
  it("rejects invalid precision and steps", () => {
    for (const [decimals, steps] of [[-1, 3], [37, 3], [6, 0], [6, 61], [6, 1.5]]) expect(splitSimulationBudget("30", decimals!, steps!)).toBeNull();
  });
  it.each(SAMPLES)("keeps the total cap and full conditions for $id", (sample) => {
    const request = buildSimulationRequest(sample, stock, stable, "30", OWNER, "test-1")!;
    expect(request.mode).toBe("SIMULATION");
    expect(request.ownerAddress).toBe(OWNER);
    expect(request.conditions.items).toEqual(sample.conditions);
    expect(BigInt(String(request.params.perStepAmountRaw ?? request.params.amountRaw)) * BigInt(sample.steps)).toBe(30_000_000n);
    if (sample.playbookId === "discount_watch") expect(request.params.maxPremiumBps).toBe(30);
  });
  it("does not request execution for unsupported output assets, and never without a connected wallet", () => {
    expect(buildSimulationRequest(SAMPLES[0]!, { ...stock, executionAllowed: false }, stable, "30", OWNER, "test-2")).toBeNull();
    expect(buildSimulationRequest(SAMPLES[0]!, stock, stable, "30", null, "test-2")).toBeNull();
    expect(buildSimulationRequest(SAMPLES[0]!, stock, stable, "30", "0x123", "test-2")).toBeNull();
  });
});

describe("Honest simulation results", () => {
  it("requires explicit simulation mode in API responses", () => {
    expect(isSimulationTask(view())).toBe(true);
    expect(isSimulationTask({ ...view(), mode: "LIVE" })).toBe(false);
    expect(isSimulationTask({ ...view(), mode: undefined })).toBe(false);
    expect(isSimulationTask({ mode: "SIMULATION", task: {} })).toBe(false);
  });
  it("does not mistake missing evidence or an empty blocker list for a pass", () => {
    expect(simulationDecision(view())).toBe("unknown");
    expect(simulationDecision(view("ACTIVE", "SATISFIED", false))).toBe("unknown");
    expect(simulationDecision(view("ACTIVE", "UNSATISFIED", false))).toBe("waiting");
    expect(simulationDecision(view("ACTIVE", "INSUFFICIENT_EVIDENCE", false))).toBe("waiting");
    expect(simulationDecision(view("ACTIVE", "SATISFIED", true, true))).toBe("waiting");
  });
  it("only calls an active, satisfied, issuable simulation ready", () => {
    expect(simulationDecision(view("ACTIVE", "SATISFIED", true))).toBe("ready");
    expect(simulationDecision(view("WAITING", "SATISFIED", true))).toBe("waiting");
    expect(simulationDecision(view("PAUSED", "SATISFIED", true))).toBe("stopped");
    expect(simulationDecision({ ...view("ACTIVE", "SATISFIED", true), mode: "LIVE" })).toBe("unknown");
  });
});

describe("Simulation-to-live handoff", () => {
  it.each(SAMPLES)("preserves $id settings through the existing form without carrying a demo owner", (sample) => {
    const request = buildSimulationRequest(sample, stock, stable, "30", OWNER, "test-3")!;
    const draft = liveDraftFromSimulation(request);
    const preset = presetFromDraft(draft, () => 6);
    expect(draft.mode).toBe("LIVE");
    expect(draft).not.toHaveProperty("ownerAddress");
    expect(draft).not.toHaveProperty("clientRequestId");
    expect(preset).toMatchObject({ playbookId: sample.playbookId, mode: "LIVE", steps: sample.steps, inputAssetKey: stable.assetKey, outputAssetKey: stock.assetKey, conditions: sample.conditions, perStepHuman: sample.steps === 3 ? "10" : "15" });
    expect(request.mode).toBe("SIMULATION");
    if (sample.playbookId === "discount_watch") expect(preset.maxPremiumBps).toBe(30);
  });
});
