"use client";
/** TradeMandate 构造 + 钱包签名 + executeStep 调用参数（用户侧执行，D-081）。 */
import { encodeFunctionData, type Hex } from "viem";
import { EIP712_TYPES_V2, makePlanGuardDomain, mandateDigest, outputSetHash, type MandateStep, type StepCertificate, type TradeMandate } from "@chaconne/core/verify";
import { PLAN_GUARD_ABI, PLANGUARD_ADDRESS } from "./planGuardAbi";
import { CHAIN_ID, signTypedData } from "./wallet";

export interface MandateDraft {
  owner: `0x${string}`;
  recipient: `0x${string}`;
  inputToken: `0x${string}`;
  outputTokens: `0x${string}`[];
  budgetCap: string;
  perStepCap: string;
  maxSteps: number;
  policyDefinitionHash: `0x${string}`;
  effectivePolicyHash: `0x${string}`;
  registryHash: `0x${string}`;
  deadlineIso: string;
}

function randomNonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return BigInt("0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("")).toString();
}

export function buildMandate(d: MandateDraft): { mandate: TradeMandate; outputSet: `0x${string}`[] } {
  const outputSet = [...new Set(d.outputTokens.map((t) => t.toLowerCase() as `0x${string}`))].sort();
  const mandate: TradeMandate = {
    owner: d.owner.toLowerCase() as `0x${string}`,
    recipient: d.recipient.toLowerCase() as `0x${string}`,
    inputToken: d.inputToken.toLowerCase() as `0x${string}`,
    outputSetHash: outputSetHash(outputSet),
    budgetCap: d.budgetCap,
    perStepCap: d.perStepCap,
    maxSteps: String(d.maxSteps),
    policyDefinitionHash: d.policyDefinitionHash,
    effectivePolicyHash: d.effectivePolicyHash,
    registryHash: d.registryHash,
    validFrom: String(Math.floor(Date.now() / 1000) - 60),
    deadline: String(Math.floor(Date.parse(d.deadlineIso) / 1000)),
    nonce: randomNonce(),
  };
  return { mandate, outputSet };
}

export function mandateTypedData(mandate: TradeMandate) {
  if (!PLANGUARD_ADDRESS) throw new Error("planguard_not_deployed");
  const domain = makePlanGuardDomain(CHAIN_ID, PLANGUARD_ADDRESS);
  return { domain, types: EIP712_TYPES_V2, primaryType: "TradeMandate" as const, message: mandate, digest: mandateDigest(domain, mandate) };
}

function big(m: TradeMandate) {
  return { ...m, budgetCap: BigInt(m.budgetCap), perStepCap: BigInt(m.perStepCap), maxSteps: Number(m.maxSteps), validFrom: BigInt(m.validFrom), deadline: BigInt(m.deadline), nonce: BigInt(m.nonce) };
}

export async function signMandate(account: `0x${string}`, mandate: TradeMandate): Promise<Hex> {
  const td = mandateTypedData(mandate);
  return signTypedData(account, td.domain, EIP712_TYPES_V2 as unknown as Record<string, Array<{ name: string; type: string }>>, "TradeMandate", big(mandate) as unknown as Record<string, unknown>);
}

export function encodeExecuteStep(args: { mandate: TradeMandate; mandateSignature: Hex; outputSet: `0x${string}`[]; step: MandateStep; certificate: StepCertificate; certificateSignature: Hex; routerCalldata: Hex }): Hex {
  const s = args.step;
  const c = args.certificate;
  return encodeFunctionData({
    abi: PLAN_GUARD_ABI,
    functionName: "executeStep",
    args: [
      big(args.mandate),
      args.mandateSignature,
      args.outputSet,
      { ...s, stepIndex: Number(s.stepIndex), amountIn: BigInt(s.amountIn), minAmountOut: BigInt(s.minAmountOut), deadline: BigInt(s.deadline) },
      { ...c, issuedAt: BigInt(c.issuedAt), validUntil: BigInt(c.validUntil), signerEpoch: BigInt(c.signerEpoch) },
      args.certificateSignature,
      args.routerCalldata,
    ],
  });
}

export function encodeRevoke(mandate: TradeMandate): Hex {
  return encodeFunctionData({ abi: PLAN_GUARD_ABI, functionName: "revokeMandate", args: [big(mandate)] });
}
