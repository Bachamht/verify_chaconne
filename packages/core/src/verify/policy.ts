/**
 * 三种显式策略的固定定义与两层哈希（技术设计 §4.4 / §5.2；v3 §0 修正 2、3）。
 *
 *  policyDefinitionHash = keccak256(canonical(PolicyDefinition))     ← 管理员在 Guard allowlist 启用
 *  effectivePolicyHash  = keccak256(canonical({ policyDefinitionHash, params }))  ← 随任务变化
 *
 * 阈值均为**本项目可调配置**（不是 OKX 保证），改动 = 新版本号 + 新哈希。
 */
import { hashCanonical } from "./canonical";
import type {
  Bytes32,
  CreateVerifyJob,
  EffectivePolicy,
  EffectivePolicyParams,
  ParamRange,
  PolicyDefinition,
  PolicyId,
} from "./contracts";

export const RULE_ENGINE_VERSION = "verify-engine/1.0.0";

const COMMON = {
  engineVersion: RULE_ENGINE_VERSION,
  mode: "exactIn" as const,
  quoteMaxAgeSeconds: 30,
  liveReferenceMaxAgeSeconds: 90,
  closeMaxSessionsSinceClose: 0,
  closeCrossVerifyToleranceBps: 50,
  certificateTtlSeconds: 60,
  futureSkewToleranceSeconds: 5,
  requireImpactKnown: true,
};

const SLIPPAGE_RANGE: ParamRange = { min: 1, max: 300, default: 50, required: true };
const IMPACT_RANGE: ParamRange = { min: 1, max: 1_000, default: 100, required: true };
const DEVIATION_RANGE: ParamRange = { min: 1, max: 2_000, default: 300, required: true };

export const POLICY_STRICT_LIVE_V1: PolicyDefinition = {
  policyId: "STRICT_LIVE",
  version: "1.0.0",
  ...COMMON,
  referenceRequirement: "live",
  sessionRequirement: "regular",
  paramRanges: {
    maxSlippageBps: SLIPPAGE_RANGE,
    maxPriceImpactBps: IMPACT_RANGE,
    maxReferenceDeviationBps: DEVIATION_RANGE,
  },
};

export const POLICY_REFERENCE_CONTEXT_V1: PolicyDefinition = {
  policyId: "REFERENCE_CONTEXT",
  version: "1.0.0",
  ...COMMON,
  referenceRequirement: "official_close",
  sessionRequirement: "any",
  paramRanges: {
    maxSlippageBps: SLIPPAGE_RANGE,
    maxPriceImpactBps: IMPACT_RANGE,
    maxReferenceDeviationBps: DEVIATION_RANGE,
  },
};

export const POLICY_QUOTE_ONLY_V1: PolicyDefinition = {
  policyId: "QUOTE_ONLY",
  version: "1.0.0",
  ...COMMON,
  referenceRequirement: "none",
  sessionRequirement: "any",
  paramRanges: {
    maxSlippageBps: SLIPPAGE_RANGE,
    maxPriceImpactBps: IMPACT_RANGE,
    // QUOTE_ONLY 不做股票参考比较：偏差参数不适用（min=max=0，default null）
    maxReferenceDeviationBps: { min: 0, max: 0, default: null, required: false },
  },
};

/* ---------- v1.1.0（CV-D06，2026-09-21）：收盘分类修正。v1.0.0 对象保持字节不变（哈希已被测试钉住） ---------- */
/** STRICT_LIVE 不接受任何收盘 kind（只认 live）；字段显式为空数组以进入哈希 */
export const POLICY_STRICT_LIVE_V1_1: PolicyDefinition = {
  ...POLICY_STRICT_LIVE_V1,
  version: "1.1.0",
  acceptedCloseKinds: [],
};
/** REFERENCE_CONTEXT 接受正式收盘、交叉核验收盘，以及 16:00 最后成交充当的收盘（报告必须标 CLOSE_UNCONFIRMED） */
export const POLICY_REFERENCE_CONTEXT_V1_1: PolicyDefinition = {
  ...POLICY_REFERENCE_CONTEXT_V1,
  version: "1.1.0",
  acceptedCloseKinds: ["official_close", "close_cross_verified", "close_last_tick"],
};
export const POLICY_QUOTE_ONLY_V1_1: PolicyDefinition = {
  ...POLICY_QUOTE_ONLY_V1,
  version: "1.1.0",
  acceptedCloseKinds: [],
};

export const POLICIES: Readonly<Record<PolicyId, readonly PolicyDefinition[]>> = {
  STRICT_LIVE: [POLICY_STRICT_LIVE_V1, POLICY_STRICT_LIVE_V1_1],
  REFERENCE_CONTEXT: [POLICY_REFERENCE_CONTEXT_V1, POLICY_REFERENCE_CONTEXT_V1_1],
  QUOTE_ONLY: [POLICY_QUOTE_ONLY_V1, POLICY_QUOTE_ONLY_V1_1],
};
/** 各策略最新版本 */
export const LATEST_POLICY_VERSION = "1.1.0";
export function latestPolicy(policyId: PolicyId): PolicyDefinition {
  const list = POLICIES[policyId];
  return list[list.length - 1]!;
}

export function findPolicy(policyId: PolicyId, version: string): PolicyDefinition | null {
  return POLICIES[policyId]?.find((p) => p.version === version) ?? null;
}

export function policyDefinitionHash(def: PolicyDefinition): Bytes32 {
  return hashCanonical(def);
}

export function effectivePolicyHash(defHash: Bytes32, params: EffectivePolicyParams): Bytes32 {
  return hashCanonical({ policyDefinitionHash: defHash, params });
}

export interface ParamResolution {
  ok: true;
  params: EffectivePolicyParams;
}
export interface ParamResolutionError {
  ok: false;
  errors: Array<{ param: keyof EffectivePolicyParams; value: number | null; range: ParamRange }>;
}

/** 用户参数落进策略范围并展开默认值；越界/缺失 → 错误（不静默夹紧）。 */
export function resolveParams(
  def: PolicyDefinition,
  job: Pick<CreateVerifyJob, "maxSlippageBps" | "maxPriceImpactBps" | "maxReferenceDeviationBps">,
): ParamResolution | ParamResolutionError {
  const errors: ParamResolutionError["errors"] = [];
  const pick = (
    name: keyof EffectivePolicyParams,
    value: number | null | undefined,
    range: ParamRange,
  ): number | null => {
    const v = value === undefined ? null : value;
    if (v === null) {
      if (range.default !== null) return range.default;
      if (range.required) errors.push({ param: name, value: null, range });
      return null;
    }
    if (!Number.isInteger(v) || v < range.min || v > range.max) {
      errors.push({ param: name, value: v, range });
      return null;
    }
    return v;
  };
  const params: EffectivePolicyParams = {
    maxSlippageBps: pick("maxSlippageBps", job.maxSlippageBps, def.paramRanges.maxSlippageBps) ?? 0,
    maxPriceImpactBps: pick("maxPriceImpactBps", job.maxPriceImpactBps, def.paramRanges.maxPriceImpactBps),
    maxReferenceDeviationBps: pick(
      "maxReferenceDeviationBps",
      job.maxReferenceDeviationBps,
      def.paramRanges.maxReferenceDeviationBps,
    ),
  };
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, params };
}

export function buildEffectivePolicy(def: PolicyDefinition, params: EffectivePolicyParams): EffectivePolicy {
  const defHash = policyDefinitionHash(def);
  return {
    definition: def,
    policyDefinitionHash: defHash,
    params,
    effectivePolicyHash: effectivePolicyHash(defHash, params),
  };
}
