/**
 * v2 黄金值生成：用 core/verify/eip712.ts（已与 viem 互检）算 PlanGuard 的 typehash / domain / 摘要，
 * 供 test/PlanGuardEip712CrossCheck.t.sol 钉死（§0 双实现互检）。
 * 运行：cd packages/core && npx tsx ../verify-contracts/script/goldenV2.ts
 */
import { domainSeparator, hashMandateStep, hashStepCertificate, hashTradeMandate, makePlanGuardDomain, mandateDigest, MANDATE_STEP_TYPEHASH, outputSetHash, STEP_CERTIFICATE_TYPEHASH, stepCertificateDigest, stepDigest, TRADE_MANDATE_TYPEHASH } from "../../core/src/verify/eip712";
import type { MandateStep, StepCertificate, TradeMandate } from "../../core/src/verify/contracts";

const GUARD = "0x1234567890123456789012345678901234567890" as const;
const A = "0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a" as const;
const N = "0x0d3db2d6a4ca2c2b6a2ae9d4e2c3f7e6a1b2c3d4" as const;
const H = (b: string) => ("0x" + b.repeat(32)) as `0x${string}`;
const domain = makePlanGuardDomain(196, GUARD);
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
const md = mandateDigest(domain, mandate);
const step: MandateStep = { mandateDigest: md, stepIndex: "0", outputToken: A, amountIn: "5000000", minAmountOut: "14908660368714889", router: "0x7c5bee2a8091c3ef39072f64f18fac913060aeaf", spender: "0x8b773d83bc66be128c60e07e17c8901f7a64f000", calldataHash: H("44"), evidenceHash: H("55"), deadline: "1789909931" };
const sd = stepDigest(domain, step);
const cert: StepCertificate = { stepDigest: sd, evidenceHash: H("55"), policyDefinitionHash: H("11"), effectivePolicyHash: H("22"), issuedAt: "1789909871", validUntil: "1789909931", signerEpoch: "1" };
console.log(JSON.stringify({
  TRADE_MANDATE_TYPEHASH, MANDATE_STEP_TYPEHASH, STEP_CERTIFICATE_TYPEHASH,
  domainSeparator: domainSeparator(domain),
  outputSetHash: mandate.outputSetHash,
  mandateStructHash: hashTradeMandate(mandate), mandateDigest: md,
  stepStructHash: hashMandateStep(step), stepDigest: sd,
  certStructHash: hashStepCertificate(cert), certDigest: stepCertificateDigest(domain, cert),
}, null, 2));
