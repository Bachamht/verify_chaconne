/**
 * CreateVerifyJob 运行时校验与规范化（HTTP / MCP / 页面共用一份，技术设计 §5.1）。
 * 零依赖手写校验：字段类型、地址、assetKey 与链一致、金额范围、策略存在、参数落范围。
 */
import { isRawAmount, parseRaw } from "./amounts";
import type { CreateVerifyJob, EffectivePolicy, NormalizedJob, PolicyId } from "./contracts";
import { buildEffectivePolicy, findPolicy, resolveParams } from "./policy";
import { isEvmAddress, isZeroAddress, normalizeAddress, parseAssetKey } from "./registry";

export interface ValidationError {
  field: string;
  code: string;
  message: string;
}

export type ValidateResult =
  | { ok: true; job: NormalizedJob; policy: EffectivePolicy }
  | { ok: false; errors: ValidationError[] };

const POLICY_IDS: readonly PolicyId[] = ["STRICT_LIVE", "REFERENCE_CONTEXT", "QUOTE_ONLY"];
const CLIENT_REQUEST_ID_RE = /^[A-Za-z0-9_\-:.]{1,128}$/;

/** 金额硬上限（最小单位），防止荒谬输入；业务层再按资产配置细化。 */
export const MAX_AMOUNT_IN_RAW = 10n ** 30n;

export function validateCreateJob(raw: unknown): ValidateResult {
  const errors: ValidationError[] = [];
  const err = (field: string, code: string, message: string) => errors.push({ field, code, message });
  if (typeof raw !== "object" || raw === null) {
    return { ok: false, errors: [{ field: "$", code: "not_object", message: "请求体必须是对象" }] };
  }
  const o = raw as Record<string, unknown>;

  const str = (f: string): string | null => (typeof o[f] === "string" ? (o[f] as string) : null);
  const intOrNull = (f: string): number | null | undefined => {
    const v = o[f];
    if (v === undefined || v === null) return v as null | undefined;
    if (typeof v === "number" && Number.isInteger(v)) return v;
    err(f, "not_integer", `${f} 必须是整数或 null`);
    return undefined;
  };

  const clientRequestId = str("clientRequestId");
  if (!clientRequestId || !CLIENT_REQUEST_ID_RE.test(clientRequestId)) err("clientRequestId", "invalid", "1–128 位 [A-Za-z0-9_-:.]");

  const owner = str("ownerAddress");
  const recipient = str("recipientAddress");
  if (!owner || !isEvmAddress(owner)) err("ownerAddress", "invalid_address", "非法 EVM 地址");
  else if (isZeroAddress(owner)) err("ownerAddress", "zero_address", "不能是零地址");
  if (!recipient || !isEvmAddress(recipient)) err("recipientAddress", "invalid_address", "非法 EVM 地址");
  else if (isZeroAddress(recipient)) err("recipientAddress", "zero_address", "不能是零地址");

  const chainId = o["executionChainId"];
  if (typeof chainId !== "number" || !Number.isInteger(chainId) || chainId <= 0) err("executionChainId", "invalid", "必须是正整数");

  const inputKey = str("inputAssetKey");
  const outputKey = str("outputAssetKey");
  const inParsed = inputKey ? parseAssetKey(inputKey) : null;
  const outParsed = outputKey ? parseAssetKey(outputKey) : null;
  if (!inParsed) err("inputAssetKey", "invalid", "格式 eip155:<chainId>:<小写地址>");
  if (!outParsed) err("outputAssetKey", "invalid", "格式 eip155:<chainId>:<小写地址>");
  if (inParsed && typeof chainId === "number" && inParsed.chainId !== chainId) err("inputAssetKey", "chain_mismatch", "与 executionChainId 不一致");
  if (outParsed && typeof chainId === "number" && outParsed.chainId !== chainId) err("outputAssetKey", "chain_mismatch", "与 executionChainId 不一致");
  if (inputKey && outputKey && inputKey === outputKey) err("outputAssetKey", "same_as_input", "输入输出资产不能相同");

  const amount = str("amountInRaw");
  if (!amount || !isRawAmount(amount)) err("amountInRaw", "invalid", "必须是十进制整数字符串");
  else {
    const v = parseRaw(amount);
    if (v <= 0n) err("amountInRaw", "not_positive", "必须大于 0");
    if (v > MAX_AMOUNT_IN_RAW) err("amountInRaw", "too_large", "超过硬上限");
  }

  if (o["mode"] !== "exactIn") err("mode", "unsupported", "首版仅支持 exactIn");
  const sideRaw = o["side"];
  if (sideRaw !== undefined && sideRaw !== "buy" && sideRaw !== "sell") err("side", "invalid", "side 只能是 buy 或 sell");

  const policyId = str("policyId");
  const policyVersion = str("policyVersion");
  const def = policyId && POLICY_IDS.includes(policyId as PolicyId) && policyVersion ? findPolicy(policyId as PolicyId, policyVersion) : null;
  if (!policyId || !POLICY_IDS.includes(policyId as PolicyId)) err("policyId", "unknown", "未知策略");
  else if (!def) err("policyVersion", "unknown", "未知策略版本");

  const maxSlippageBps = intOrNull("maxSlippageBps");
  const maxPriceImpactBps = intOrNull("maxPriceImpactBps");
  const maxReferenceDeviationBps = intOrNull("maxReferenceDeviationBps");
  if (maxSlippageBps === null || maxSlippageBps === undefined) {
    if (maxSlippageBps === null) err("maxSlippageBps", "required", "必须显式给出");
  }

  if (errors.length > 0 || !def) return { ok: false, errors };

  const resolved = resolveParams(def, {
    maxSlippageBps: maxSlippageBps as number,
    maxPriceImpactBps: maxPriceImpactBps ?? null,
    maxReferenceDeviationBps: maxReferenceDeviationBps ?? null,
  });
  if (!resolved.ok) {
    for (const e of resolved.errors) {
      err(e.param, "out_of_range", `${e.param}=${e.value} 不在 [${e.range.min}, ${e.range.max}]`);
    }
    return { ok: false, errors };
  }

  const policy = buildEffectivePolicy(def, resolved.params);
  const job: NormalizedJob = {
    clientRequestId: clientRequestId as string,
    ownerAddress: normalizeAddress(owner as string),
    recipientAddress: normalizeAddress(recipient as string),
    executionChainId: chainId as number,
    inputAssetKey: inputKey as string,
    outputAssetKey: outputKey as string,
    amountInRaw: amount as string,
    mode: "exactIn",
    policyId: def.policyId,
    policyVersion: def.version,
    params: resolved.params,
    ...(sideRaw === "sell" ? { side: "sell" as const } : {}),
  };
  return { ok: true, job, policy };
}

/** 把已校验任务还原成对外 CreateVerifyJob 形态（幂等冲突比对用）。 */
export function toCreateVerifyJob(job: NormalizedJob): CreateVerifyJob {
  return {
    clientRequestId: job.clientRequestId,
    ownerAddress: job.ownerAddress,
    recipientAddress: job.recipientAddress,
    executionChainId: job.executionChainId,
    inputAssetKey: job.inputAssetKey,
    outputAssetKey: job.outputAssetKey,
    amountInRaw: job.amountInRaw,
    mode: job.mode,
    policyId: job.policyId,
    policyVersion: job.policyVersion,
    maxSlippageBps: job.params.maxSlippageBps,
    maxPriceImpactBps: job.params.maxPriceImpactBps,
    maxReferenceDeviationBps: job.params.maxReferenceDeviationBps,
    ...(job.side === "sell" ? { side: "sell" as const } : {}),
  };
}
