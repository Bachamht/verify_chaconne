/** v2 PlanGuard EIP-712 双实现互检：手写编码 vs viem.hashTypedData；outputSetHash vs viem encodePacked */
import { describe, expect, it } from "vitest";
import { encodePacked, hashTypedData, keccak256 } from "viem";
import { EIP712_TYPES_V2, hashMandateStep, hashStepCertificate, hashTradeMandate, makePlanGuardDomain, mandateDigest, outputSetHash, stepCertificateDigest, stepDigest, typedDataDigest } from "../src/verify/eip712";
import type { MandateStep, StepCertificate, TradeMandate } from "../src/verify/contracts";

const GUARD = "0x1234567890123456789012345678901234567890" as const;
const A = "0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a" as const;
const N = "0x0d3db2d6a4ca2c2b6a2ae9d4e2c3f7e6a1b2c3d4" as const;
const H = (b: string) => ("0x" + b.repeat(32)) as `0x${string}`;

const mandate: TradeMandate = {
  owner: "0xbacb138e0e9e1444bae9b401c4615378c57c0381",
  recipient: "0xbacb138e0e9e1444bae9b401c4615378c57c0381",
  inputToken: "0x4ae46a509f6b1d9056937ba4500cb143933d2dc8",
  outputSetHash: outputSetHash([N, A]),
  budgetCap: "10000000",
  perStepCap: "5000000",
  maxSteps: "3",
  policyDefinitionHash: H("11"),
  effectivePolicyHash: H("22"),
  registryHash: H("33"),
  validFrom: "1789900000",
  deadline: "1790000000",
  nonce: "7",
};

describe("PlanGuard EIP-712 v2", () => {
  const domain = makePlanGuardDomain(196, GUARD);
  const viemDomain = { name: "ChaconneVerifyPlanGuard", version: "1", chainId: 196, verifyingContract: GUARD } as const;

  it("outputSetHash = keccak256(encodePacked(sorted addresses))，顺序无关、去重", () => {
    const expected = keccak256(encodePacked(["address", "address"], [N, A]));
    expect(outputSetHash([A, N])).toBe(expected);
    expect(outputSetHash([N, A, A])).toBe(expected);
  });

  it("TradeMandate 摘要与 viem 一致", () => {
    const theirs = hashTypedData({ domain: viemDomain, types: EIP712_TYPES_V2, primaryType: "TradeMandate", message: { ...mandate, budgetCap: 10000000n, perStepCap: 5000000n, maxSteps: 3, validFrom: 1789900000n, deadline: 1790000000n, nonce: 7n } });
    expect(mandateDigest(domain, mandate)).toBe(theirs);
    expect(typedDataDigest(domain, hashTradeMandate(mandate))).toBe(theirs);
  });

  it("MandateStep / StepCertificate 摘要与 viem 一致；uint32 越界拒绝", () => {
    const step: MandateStep = { mandateDigest: mandateDigest(domain, mandate), stepIndex: "0", outputToken: A, amountIn: "5000000", minAmountOut: "14908660368714889", router: "0x7c5bee2a8091c3ef39072f64f18fac913060aeaf", spender: "0x8b773d83bc66be128c60e07e17c8901f7a64f000", calldataHash: H("44"), evidenceHash: H("55"), deadline: "1789909931" };
    const sd = stepDigest(domain, step);
    expect(sd).toBe(hashTypedData({ domain: viemDomain, types: EIP712_TYPES_V2, primaryType: "MandateStep", message: { ...step, stepIndex: 0, amountIn: 5000000n, minAmountOut: 14908660368714889n, deadline: 1789909931n } }));
    const cert: StepCertificate = { stepDigest: sd, evidenceHash: H("55"), policyDefinitionHash: H("11"), effectivePolicyHash: H("22"), issuedAt: "1789909871", validUntil: "1789909931", signerEpoch: "1" };
    expect(stepCertificateDigest(domain, cert)).toBe(hashTypedData({ domain: viemDomain, types: EIP712_TYPES_V2, primaryType: "StepCertificate", message: { ...cert, issuedAt: 1789909871n, validUntil: 1789909931n, signerEpoch: 1n } }));
    expect(hashStepCertificate(cert)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(() => hashMandateStep({ ...step, stepIndex: String(2 ** 32) })).toThrow(/越界/);
    expect(() => hashTradeMandate({ ...mandate, maxSteps: String(2 ** 32) })).toThrow(/越界/);
  });

  it("domain 与 v1 Guard 不同：同一结构在两个 domain 下摘要不同", () => {
    const other = { ...domain, name: "ChaconneVerifyGuard" as const };
    expect(mandateDigest(other, mandate)).not.toBe(mandateDigest(domain, mandate));
  });
});
