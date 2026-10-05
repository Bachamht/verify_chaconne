/**
 * 发送前的本地核对（不信任服务端交来的 READY 体）：mandate digest 与步骤一致、证书 stepDigest = 重算的步骤摘要、
 * 证书 effectivePolicyHash = mandate、calldataHash = keccak(routerCalldata)、输出集排序与哈希、输出代币在集内、
 * 链 id 与 PlanGuard 地址、每笔上限、证书 / 步骤剩余时间。返回问题列表（空 = 通过）。
 */
import type { Hex } from "viem";
import { calldataHash, makePlanGuardDomain, mandateDigest, outputSetHash, stepDigest, type MandateStep, type StepCertificate, type TradeMandate } from "@chaconne/core/verify";
import { normalizeOutputSet } from "./abi";

export interface ReadyStepBody {
  step: MandateStep;
  certificate: StepCertificate;
  certificateSignature: Hex;
  routerCalldata: Hex;
  outputSet: string[];
  planGuard: string;
  mandate: TradeMandate;
  mandateSignature: Hex;
}

export interface LocalCheckOptions {
  chainId: number;
  /** 配置的 PlanGuard（READY 体里的地址必须相等） */
  planGuard: Hex;
  nowSec: number;
  /** 证书剩余低于它不发（EXECUTOR_MIN_CERT_REMAINING_S） */
  minRemainingS: number;
  expectedStepIndex?: number;
  /** hosted：作业 owner 必须等于 mandate.owner */
  expectedOwner?: Hex;
}

export interface LocalCheckResult {
  ok: boolean;
  problems: string[];
  /** 证书剩余不足单列：失败分类 = retry_new_cert */
  certRemainingLow: boolean;
  outputSet: Hex[];
  mandateDigest: Hex;
  stepDigest: Hex;
}

export function checkReadyStep(r: ReadyStepBody, o: LocalCheckOptions): LocalCheckResult {
  const problems: string[] = [];
  let outputSet: Hex[] = [];
  try {
    outputSet = normalizeOutputSet(r.outputSet);
  } catch {
    problems.push("outputSet empty");
  }
  if (r.planGuard.toLowerCase() !== o.planGuard.toLowerCase()) problems.push(`planGuard ${r.planGuard} ≠ configured ${o.planGuard}`);
  const domain = makePlanGuardDomain(o.chainId, o.planGuard);
  const md = mandateDigest(domain, r.mandate);
  const sd = stepDigest(domain, r.step);
  if (r.step.mandateDigest.toLowerCase() !== md.toLowerCase()) problems.push("step.mandateDigest ≠ local mandate digest");
  if (sd.toLowerCase() !== r.certificate.stepDigest.toLowerCase()) problems.push("certificate.stepDigest ≠ recomputed step digest");
  if (r.certificate.effectivePolicyHash.toLowerCase() !== r.mandate.effectivePolicyHash.toLowerCase()) problems.push("certificate.effectivePolicyHash ≠ mandate.effectivePolicyHash");
  if (r.certificate.evidenceHash.toLowerCase() !== r.step.evidenceHash.toLowerCase()) problems.push("certificate.evidenceHash ≠ step.evidenceHash");
  if (calldataHash(r.routerCalldata).toLowerCase() !== r.step.calldataHash.toLowerCase()) problems.push("calldataHash ≠ keccak(routerCalldata)");
  if (outputSet.length && outputSetHash(outputSet).toLowerCase() !== r.mandate.outputSetHash.toLowerCase()) problems.push("outputSet hash ≠ mandate.outputSetHash");
  if (outputSet.length && !outputSet.includes(r.step.outputToken.toLowerCase() as Hex)) problems.push("step.outputToken not in outputSet");
  if (BigInt(r.step.amountIn) <= 0n || BigInt(r.step.amountIn) > BigInt(r.mandate.perStepCap)) problems.push("amountIn not in (0, perStepCap]");
  if (BigInt(r.step.minAmountOut) <= 0n) problems.push("minAmountOut must be > 0");
  if (o.expectedStepIndex !== undefined && Number(r.step.stepIndex) !== o.expectedStepIndex) problems.push(`stepIndex ${r.step.stepIndex} ≠ expected ${o.expectedStepIndex}`);
  if (o.expectedOwner && r.mandate.owner.toLowerCase() !== o.expectedOwner.toLowerCase()) problems.push("mandate.owner ≠ job owner");
  const remain = Math.min(Number(r.certificate.validUntil), Number(r.step.deadline)) - o.nowSec;
  const certRemainingLow = remain < o.minRemainingS;
  if (certRemainingLow) problems.push(`certificate remaining ${remain}s < ${o.minRemainingS}s`);
  return { ok: problems.length === 0, problems, certRemainingLow, outputSet, mandateDigest: md, stepDigest: sd };
}
