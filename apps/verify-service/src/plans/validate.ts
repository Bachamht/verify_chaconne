/** PlanGoal 校验（服务侧；core validate 是 A2 的，这里只做结构与范围） */
import { findPolicy, isEvmAddress, isRawAmount, normalizeAddress, type PlanGoal, type PolicyId, LATEST_POLICY_VERSION } from "@chaconne/core/verify";

export interface GoalError {
  field: string;
  code: string;
}
export type GoalResult = { ok: true; goal: PlanGoal; clientRequestId: string } | { ok: false; errors: GoalError[] };

const POLICY_IDS = new Set(["STRICT_LIVE", "REFERENCE_CONTEXT", "QUOTE_ONLY"]);

export function validatePlanGoal(raw: unknown, chainId: number): GoalResult {
  const errors: GoalError[] = [];
  const b = (raw ?? {}) as Record<string, unknown>;
  const owner = typeof b["ownerAddress"] === "string" && isEvmAddress(b["ownerAddress"]) ? normalizeAddress(b["ownerAddress"]) : null;
  if (!owner) errors.push({ field: "ownerAddress", code: "invalid_address" });
  const recipientRaw = b["recipientAddress"];
  const recipient = recipientRaw === undefined || recipientRaw === null || recipientRaw === "" ? owner : typeof recipientRaw === "string" && isEvmAddress(recipientRaw) ? normalizeAddress(recipientRaw) : null;
  if (!recipient) errors.push({ field: "recipientAddress", code: "invalid_address" });
  const legsRaw = Array.isArray(b["legs"]) ? (b["legs"] as unknown[]) : null;
  const legs: PlanGoal["legs"] = [];
  if (!legsRaw || legsRaw.length === 0 || legsRaw.length > 4) errors.push({ field: "legs", code: "expected_1_to_4" });
  else {
    let sum = 0;
    for (const l of legsRaw) {
      const o = (l ?? {}) as Record<string, unknown>;
      const w = typeof o["weightBps"] === "number" ? o["weightBps"] : legsRaw.length === 1 ? 10_000 : NaN;
      if (typeof o["outputAssetKey"] !== "string" || !/^eip155:\d+:0x[0-9a-fA-F]{40}$/.test(o["outputAssetKey"])) errors.push({ field: "legs.outputAssetKey", code: "invalid_asset_key" });
      if (!Number.isInteger(w) || w <= 0 || w > 10_000) errors.push({ field: "legs.weightBps", code: "out_of_range" });
      sum += Number.isInteger(w) ? w : 0;
      legs.push({ outputAssetKey: String(o["outputAssetKey"] ?? "").toLowerCase(), weightBps: w });
    }
    if (sum !== 10_000) errors.push({ field: "legs.weightBps", code: "must_sum_to_10000" });
  }
  const budget = (b["budget"] ?? {}) as Record<string, unknown>;
  const inputs = Array.isArray(budget["inputAssetKeys"]) ? (budget["inputAssetKeys"] as unknown[]).filter((x): x is string => typeof x === "string").map((x) => x.toLowerCase()) : [];
  if (inputs.length === 0 || inputs.length > 3 || inputs.some((x) => !/^eip155:\d+:0x[0-9a-f]{40}$/.test(x))) errors.push({ field: "budget.inputAssetKeys", code: "expected_1_to_3_asset_keys" });
  if (!isRawAmount(budget["amountInRaw"]) || BigInt(budget["amountInRaw"] as string) <= 0n) errors.push({ field: "budget.amountInRaw", code: "invalid_raw_amount" });
  const side = b["side"] === "sell" ? "sell" : b["side"] === undefined || b["side"] === "buy" ? "buy" : null;
  if (!side) errors.push({ field: "side", code: "expected_buy_or_sell" });
  const policyId = typeof b["policyId"] === "string" && POLICY_IDS.has(b["policyId"]) ? (b["policyId"] as PolicyId) : null;
  if (!policyId) errors.push({ field: "policyId", code: "unknown_policy" });
  const policyVersion = typeof b["policyVersion"] === "string" ? b["policyVersion"] : LATEST_POLICY_VERSION;
  if (policyId && !findPolicy(policyId, policyVersion)) errors.push({ field: "policyVersion", code: "unknown_version" });
  const int = (k: string, required: boolean) => {
    const v = b[k];
    if (v === undefined || v === null) {
      if (required) errors.push({ field: k, code: "required" });
      return null;
    }
    if (!Number.isInteger(v)) {
      errors.push({ field: k, code: "not_integer" });
      return null;
    }
    return v as number;
  };
  const maxSlippageBps = int("maxSlippageBps", true) ?? 0;
  const maxPriceImpactBps = int("maxPriceImpactBps", false);
  const maxReferenceDeviationBps = int("maxReferenceDeviationBps", false);
  const deadline = typeof b["deadline"] === "string" && !Number.isNaN(Date.parse(b["deadline"])) ? new Date(Date.parse(b["deadline"])).toISOString() : null;
  if (!deadline) errors.push({ field: "deadline", code: "invalid_iso" });
  const ladder = b["ladderBps"];
  if (ladder !== undefined && (!Array.isArray(ladder) || ladder.length === 0 || ladder.length > 8 || ladder.some((x) => !Number.isInteger(x) || x <= 0 || x > 10_000))) errors.push({ field: "ladderBps", code: "invalid" });
  const clientRequestId = typeof b["clientRequestId"] === "string" && /^[A-Za-z0-9_\-:.]{1,128}$/.test(b["clientRequestId"]) ? b["clientRequestId"] : null;
  if (!clientRequestId) errors.push({ field: "clientRequestId", code: "required" });
  if (errors.length > 0) return { ok: false, errors };
  const goal: PlanGoal = {
    ownerAddress: owner!,
    recipientAddress: recipient!,
    executionChainId: chainId,
    legs,
    budget: { inputAssetKeys: inputs, amountInRaw: budget["amountInRaw"] as string },
    side: side!,
    policyId: policyId!,
    policyVersion,
    maxSlippageBps,
    maxPriceImpactBps,
    ...(maxReferenceDeviationBps !== null ? { maxReferenceDeviationBps } : {}),
    deadline: deadline!,
    ...(Array.isArray(ladder) ? { ladderBps: ladder as number[] } : {}),
  };
  return { ok: true, goal, clientRequestId: clientRequestId! };
}
