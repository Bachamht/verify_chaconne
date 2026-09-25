/**
 * /play → /plan 的承接（VERIFY-UX-REVIEW P2）：试玩结果的「改成我的预算」跳到 /plan?from_simulation=<id>，
 * 规划页读取该模拟的 goal，把资产、方向、策略、限额与示例预算预填进表单；owner 与 deadline 不带（由用户当场确认）。
 * 纯函数，页面与测试共用。
 */
import type { PlanGoal } from "@chaconne/core/verify";
import { rawToHuman } from "@/lib/format";

export interface PlanPrefill {
  side: "buy" | "sell";
  legs: Array<{ outputAssetKey: string; weightBps: number }>;
  inputs: string[];
  policy: PlanGoal["policyId"];
  slippage: number;
  impact: number;
  deviation: number;
  /** 人类单位；按首个资金币种精度换算，找不到精度时为 null（表单保留原值） */
  budgetHuman: string | null;
}

export function prefillFromSimulationGoal(goal: PlanGoal | null | undefined, decimalsOf: (assetKey: string) => number | null): PlanPrefill | null {
  if (!goal || !Array.isArray(goal.legs) || goal.legs.length === 0) return null;
  const inputs = Array.isArray(goal.budget?.inputAssetKeys) ? goal.budget.inputAssetKeys.filter((k): k is string => typeof k === "string" && k.length > 0) : [];
  const legs = goal.legs
    .filter((l) => l && typeof l.outputAssetKey === "string" && Number.isInteger(l.weightBps) && l.weightBps > 0)
    .map((l) => ({ outputAssetKey: l.outputAssetKey, weightBps: l.weightBps }));
  if (legs.length === 0) return null;
  const dec = inputs[0] ? decimalsOf(inputs[0]) : null;
  const raw = goal.budget?.amountInRaw;
  const budgetHuman = dec !== null && typeof raw === "string" && /^\d+$/.test(raw) && BigInt(raw) > 0n ? rawToHuman(raw, dec, dec) : null;
  return {
    side: goal.side === "sell" ? "sell" : "buy",
    legs,
    inputs,
    policy: goal.policyId,
    slippage: Number.isInteger(goal.maxSlippageBps) ? goal.maxSlippageBps : 50,
    impact: Number.isInteger(goal.maxPriceImpactBps) ? (goal.maxPriceImpactBps as number) : 100,
    deviation: Number.isInteger(goal.maxReferenceDeviationBps) ? (goal.maxReferenceDeviationBps as number) : 300,
    budgetHuman,
  };
}
