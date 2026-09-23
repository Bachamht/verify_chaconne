/**
 * ConditionSet.hash = keccak256(canonical({version, items}))（interfaces §11.4）。
 * 进入 effectivePolicyHash 的展开参数 → 进证书与证据包；验证器用保存的输入复算（K-10）。
 */
import { hashCanonical } from "../canonical";
import type { Bytes32, Condition, ConditionSet, EffectivePolicyParams } from "../contracts";

export const CONDITIONS_VERSION = "conditions/1" as const;

export function conditionsHash(items: readonly Condition[], version: ConditionSet["version"] = CONDITIONS_VERSION): Bytes32 {
  return hashCanonical({ version, items });
}

export function makeConditionSet(items: readonly Condition[]): ConditionSet {
  const list = [...items];
  return { version: CONDITIONS_VERSION, items: list, hash: conditionsHash(list) };
}

/** 任务授权的策略参数 = 既有三参数 + conditionsHash（结构扩展，不改冻结的 EffectivePolicyParams） */
export type TaskPolicyParams = EffectivePolicyParams & { conditionsHash: Bytes32 };

export function withConditionsHash(params: EffectivePolicyParams, hash: Bytes32): TaskPolicyParams {
  return { maxSlippageBps: params.maxSlippageBps, maxPriceImpactBps: params.maxPriceImpactBps, maxReferenceDeviationBps: params.maxReferenceDeviationBps, conditionsHash: hash };
}

/** 从任意 params 对象取 conditionsHash（证据包 / 证书复算用） */
export function conditionsHashOfParams(params: unknown): Bytes32 | null {
  if (typeof params !== "object" || params === null) return null;
  const h = (params as Record<string, unknown>)["conditionsHash"];
  return typeof h === "string" && /^0x[0-9a-f]{64}$/.test(h) ? (h as Bytes32) : null;
}
