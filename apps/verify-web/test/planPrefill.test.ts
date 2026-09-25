/** /play → /plan 承接：from_simulation 只预填结构与示例预算，不带 owner / deadline；坏数据不崩。 */
import { describe, expect, it } from "vitest";
import type { PlanGoal } from "@chaconne/core/verify";
import { prefillFromSimulationGoal } from "../components/planPrefill";

const USDG = "eip155:196:0x4ae46a509f6b1d9056937ba4500cb143933d2dc8";
const AAPLX = "eip155:196:0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a";
const NVDAX = "eip155:196:0x1234567890123456789012345678901234567890";
const OWNER = "0xbacb0000000000000000000000000000000f0381";
const goal: PlanGoal = {
  ownerAddress: OWNER, recipientAddress: OWNER, executionChainId: 196,
  legs: [{ outputAssetKey: AAPLX, weightBps: 5000 }, { outputAssetKey: NVDAX, weightBps: 5000 }],
  budget: { inputAssetKeys: [USDG], amountInRaw: "50000000" },
  side: "buy", policyId: "REFERENCE_CONTEXT", policyVersion: "1.1.0", maxSlippageBps: 50, maxPriceImpactBps: 100, maxReferenceDeviationBps: 300,
  deadline: "2026-09-25T00:00:00.000Z",
};
const decimalsOf = (k: string) => (k === USDG ? 6 : null);

describe("from_simulation 预填", () => {
  it("带入资产、方向、策略、限额与示例预算（按资金币种精度换成人类单位）", () => {
    const pre = prefillFromSimulationGoal(goal, decimalsOf)!;
    expect(pre).toEqual({ side: "buy", legs: goal.legs, inputs: [USDG], policy: "REFERENCE_CONTEXT", slippage: 50, impact: 100, deviation: 300, budgetHuman: "50" });
    expect(pre).not.toHaveProperty("ownerAddress");
    expect(pre).not.toHaveProperty("deadline");
  });
  it("QUOTE_ONLY 的空偏差与未知精度回落到表单默认值，预算保留原值", () => {
    const pre = prefillFromSimulationGoal({ ...goal, policyId: "QUOTE_ONLY", maxReferenceDeviationBps: null, maxPriceImpactBps: 10 }, () => null)!;
    expect(pre.policy).toBe("QUOTE_ONLY");
    expect(pre.deviation).toBe(300);
    expect(pre.impact).toBe(10);
    expect(pre.budgetHuman).toBeNull();
  });
  it("缺腿、零权重或缺 goal 时不预填", () => {
    expect(prefillFromSimulationGoal(null, decimalsOf)).toBeNull();
    expect(prefillFromSimulationGoal({ ...goal, legs: [] }, decimalsOf)).toBeNull();
    expect(prefillFromSimulationGoal({ ...goal, legs: [{ outputAssetKey: AAPLX, weightBps: 0 }] }, decimalsOf)).toBeNull();
    expect(prefillFromSimulationGoal({ ...goal, budget: { inputAssetKeys: [USDG], amountInRaw: "abc" } }, decimalsOf)!.budgetHuman).toBeNull();
  });
});
