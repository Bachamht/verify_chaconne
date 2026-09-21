/**
 * EIP-712 编码（技术设计 §9.2）——独立实现，不依赖 viem；测试中与 viem 互检（§0 双实现互检）。
 *
 * domain: { name: "ChaconneVerifyGuard", version: "1", chainId, verifyingContract }
 * TradeIntent / VerificationCertificate 字段顺序 = 合约 struct 顺序，一经部署冻结。
 */
import { hexToBytes, keccak256Hex, keccak256Utf8 } from "./canonical";
import type { Bytes32, Eip712Domain, TradeIntent, VerificationCertificate } from "./contracts";

export const EIP712_DOMAIN_NAME = "ChaconneVerifyGuard" as const;
export const EIP712_DOMAIN_VERSION = "1" as const;

export const TRADE_INTENT_TYPE =
  "TradeIntent(address owner,address recipient,address inputToken,address outputToken,uint256 amountIn,uint256 minAmountOut,address router,address spender,bytes32 calldataHash,bytes32 policyDefinitionHash,bytes32 effectivePolicyHash,bytes32 registryHash,bytes32 evidenceHash,uint256 nonce,uint64 deadline)";

export const VERIFICATION_CERTIFICATE_TYPE =
  "VerificationCertificate(bytes32 intentDigest,bytes32 evidenceHash,bytes32 policyDefinitionHash,bytes32 effectivePolicyHash,uint64 issuedAt,uint64 validUntil,uint64 signerEpoch)";

export const EIP712_DOMAIN_TYPE =
  "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)";

/** viem/ethers 风格的 types 对象（给钱包 signTypedData 用）。 */
export const EIP712_TYPES = {
  TradeIntent: [
    { name: "owner", type: "address" },
    { name: "recipient", type: "address" },
    { name: "inputToken", type: "address" },
    { name: "outputToken", type: "address" },
    { name: "amountIn", type: "uint256" },
    { name: "minAmountOut", type: "uint256" },
    { name: "router", type: "address" },
    { name: "spender", type: "address" },
    { name: "calldataHash", type: "bytes32" },
    { name: "policyDefinitionHash", type: "bytes32" },
    { name: "effectivePolicyHash", type: "bytes32" },
    { name: "registryHash", type: "bytes32" },
    { name: "evidenceHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "deadline", type: "uint64" },
  ],
  VerificationCertificate: [
    { name: "intentDigest", type: "bytes32" },
    { name: "evidenceHash", type: "bytes32" },
    { name: "policyDefinitionHash", type: "bytes32" },
    { name: "effectivePolicyHash", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "validUntil", type: "uint64" },
    { name: "signerEpoch", type: "uint64" },
  ],
} as const;

export const TRADE_INTENT_TYPEHASH: Bytes32 = keccak256Utf8(TRADE_INTENT_TYPE);
export const VERIFICATION_CERTIFICATE_TYPEHASH: Bytes32 = keccak256Utf8(VERIFICATION_CERTIFICATE_TYPE);
export const EIP712_DOMAIN_TYPEHASH: Bytes32 = keccak256Utf8(EIP712_DOMAIN_TYPE);

const UINT256_MAX = (1n << 256n) - 1n;
const UINT64_MAX = (1n << 64n) - 1n;

function word(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 32) throw new Error("word 超过 32 字节");
  const out = new Uint8Array(32);
  out.set(bytes, 32 - bytes.length);
  return out;
}

function uintWord(value: string | bigint, max: bigint, label: string): Uint8Array {
  const v = typeof value === "bigint" ? value : BigInt(value);
  if (v < 0n || v > max) throw new Error(`${label} 越界: ${value}`);
  const hex = v.toString(16).padStart(64, "0");
  return hexToBytes(hex);
}

function addressWord(addr: string): Uint8Array {
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) throw new Error(`非法地址: ${addr}`);
  return word(hexToBytes(addr));
}

function bytes32Word(h: string): Uint8Array {
  if (!/^0x[0-9a-fA-F]{64}$/.test(h)) throw new Error(`非法 bytes32: ${h}`);
  return hexToBytes(h);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

export function domainSeparator(domain: Eip712Domain): Bytes32 {
  return keccak256Hex(
    concat([
      bytes32Word(EIP712_DOMAIN_TYPEHASH),
      bytes32Word(keccak256Utf8(domain.name)),
      bytes32Word(keccak256Utf8(domain.version)),
      uintWord(BigInt(domain.chainId), UINT256_MAX, "chainId"),
      addressWord(domain.verifyingContract),
    ]),
  );
}

export function hashTradeIntent(intent: TradeIntent): Bytes32 {
  return keccak256Hex(
    concat([
      bytes32Word(TRADE_INTENT_TYPEHASH),
      addressWord(intent.owner),
      addressWord(intent.recipient),
      addressWord(intent.inputToken),
      addressWord(intent.outputToken),
      uintWord(intent.amountIn, UINT256_MAX, "amountIn"),
      uintWord(intent.minAmountOut, UINT256_MAX, "minAmountOut"),
      addressWord(intent.router),
      addressWord(intent.spender),
      bytes32Word(intent.calldataHash),
      bytes32Word(intent.policyDefinitionHash),
      bytes32Word(intent.effectivePolicyHash),
      bytes32Word(intent.registryHash),
      bytes32Word(intent.evidenceHash),
      uintWord(intent.nonce, UINT256_MAX, "nonce"),
      uintWord(intent.deadline, UINT64_MAX, "deadline"),
    ]),
  );
}

export function hashVerificationCertificate(cert: VerificationCertificate): Bytes32 {
  return keccak256Hex(
    concat([
      bytes32Word(VERIFICATION_CERTIFICATE_TYPEHASH),
      bytes32Word(cert.intentDigest),
      bytes32Word(cert.evidenceHash),
      bytes32Word(cert.policyDefinitionHash),
      bytes32Word(cert.effectivePolicyHash),
      uintWord(cert.issuedAt, UINT64_MAX, "issuedAt"),
      uintWord(cert.validUntil, UINT64_MAX, "validUntil"),
      uintWord(cert.signerEpoch, UINT64_MAX, "signerEpoch"),
    ]),
  );
}

/** EIP-712 最终摘要：keccak256(0x1901 ‖ domainSeparator ‖ structHash)。 */
export function typedDataDigest(domain: Eip712Domain, structHash: Bytes32): Bytes32 {
  return keccak256Hex(
    concat([new Uint8Array([0x19, 0x01]), bytes32Word(domainSeparator(domain)), bytes32Word(structHash)]),
  );
}

/** 用户签署的 TradeIntent 摘要（= 证书里的 intentDigest）。 */
export function intentDigest(domain: Eip712Domain, intent: TradeIntent): Bytes32 {
  return typedDataDigest(domain, hashTradeIntent(intent));
}

/** 证明身份签署的 VerificationCertificate 摘要。 */
export function certificateDigest(domain: Eip712Domain, cert: VerificationCertificate): Bytes32 {
  return typedDataDigest(domain, hashVerificationCertificate(cert));
}

export function makeDomain(chainId: number, verifyingContract: `0x${string}`): Eip712Domain {
  return { name: EIP712_DOMAIN_NAME, version: EIP712_DOMAIN_VERSION, chainId, verifyingContract };
}

/** calldata → bytes32（intent.calldataHash） */
export function calldataHash(calldataHex: `0x${string}`): Bytes32 {
  return keccak256Hex(hexToBytes(calldataHex));
}

/* ================================================================== */
/* v2：PlanGuard（升级执行计划 v5 §3.2）——独立 domain，天然不可跨合约重放  */
/* ================================================================== */
import type { MandateStep, StepCertificate, TradeMandate } from "./contracts";

export const PLANGUARD_DOMAIN_NAME = "ChaconneVerifyPlanGuard" as const;
export const PLANGUARD_DOMAIN_VERSION = "1" as const;

export const TRADE_MANDATE_TYPE =
  "TradeMandate(address owner,address recipient,address inputToken,bytes32 outputSetHash,uint256 budgetCap,uint256 perStepCap,uint32 maxSteps,bytes32 policyDefinitionHash,bytes32 effectivePolicyHash,bytes32 registryHash,uint64 validFrom,uint64 deadline,uint256 nonce)";
export const MANDATE_STEP_TYPE =
  "MandateStep(bytes32 mandateDigest,uint32 stepIndex,address outputToken,uint256 amountIn,uint256 minAmountOut,address router,address spender,bytes32 calldataHash,bytes32 evidenceHash,uint64 deadline)";
export const STEP_CERTIFICATE_TYPE =
  "StepCertificate(bytes32 stepDigest,bytes32 evidenceHash,bytes32 policyDefinitionHash,bytes32 effectivePolicyHash,uint64 issuedAt,uint64 validUntil,uint64 signerEpoch)";

export const EIP712_TYPES_V2 = {
  TradeMandate: [
    { name: "owner", type: "address" },
    { name: "recipient", type: "address" },
    { name: "inputToken", type: "address" },
    { name: "outputSetHash", type: "bytes32" },
    { name: "budgetCap", type: "uint256" },
    { name: "perStepCap", type: "uint256" },
    { name: "maxSteps", type: "uint32" },
    { name: "policyDefinitionHash", type: "bytes32" },
    { name: "effectivePolicyHash", type: "bytes32" },
    { name: "registryHash", type: "bytes32" },
    { name: "validFrom", type: "uint64" },
    { name: "deadline", type: "uint64" },
    { name: "nonce", type: "uint256" },
  ],
  MandateStep: [
    { name: "mandateDigest", type: "bytes32" },
    { name: "stepIndex", type: "uint32" },
    { name: "outputToken", type: "address" },
    { name: "amountIn", type: "uint256" },
    { name: "minAmountOut", type: "uint256" },
    { name: "router", type: "address" },
    { name: "spender", type: "address" },
    { name: "calldataHash", type: "bytes32" },
    { name: "evidenceHash", type: "bytes32" },
    { name: "deadline", type: "uint64" },
  ],
  StepCertificate: [
    { name: "stepDigest", type: "bytes32" },
    { name: "evidenceHash", type: "bytes32" },
    { name: "policyDefinitionHash", type: "bytes32" },
    { name: "effectivePolicyHash", type: "bytes32" },
    { name: "issuedAt", type: "uint64" },
    { name: "validUntil", type: "uint64" },
    { name: "signerEpoch", type: "uint64" },
  ],
} as const;

export const TRADE_MANDATE_TYPEHASH: Bytes32 = keccak256Utf8(TRADE_MANDATE_TYPE);
export const MANDATE_STEP_TYPEHASH: Bytes32 = keccak256Utf8(MANDATE_STEP_TYPE);
export const STEP_CERTIFICATE_TYPEHASH: Bytes32 = keccak256Utf8(STEP_CERTIFICATE_TYPE);
const UINT32_MAX = (1n << 32n) - 1n;

export function makePlanGuardDomain(chainId: number, verifyingContract: `0x${string}`): Eip712Domain {
  return { name: PLANGUARD_DOMAIN_NAME, version: PLANGUARD_DOMAIN_VERSION, chainId, verifyingContract };
}

/** outputSetHash = keccak256(abi.encodePacked(sorted addresses))；排序按小写十六进制字典序，去重 */
export function outputSetHash(tokens: readonly `0x${string}`[]): Bytes32 {
  const sorted = [...new Set(tokens.map((t) => t.toLowerCase()))].sort();
  if (sorted.length === 0) throw new Error("outputSet 为空");
  return keccak256Hex(concat(sorted.map((t) => hexToBytes(t))));
}

export function hashTradeMandate(m: TradeMandate): Bytes32 {
  return keccak256Hex(
    concat([
      bytes32Word(TRADE_MANDATE_TYPEHASH),
      addressWord(m.owner),
      addressWord(m.recipient),
      addressWord(m.inputToken),
      bytes32Word(m.outputSetHash),
      uintWord(m.budgetCap, UINT256_MAX, "budgetCap"),
      uintWord(m.perStepCap, UINT256_MAX, "perStepCap"),
      uintWord(m.maxSteps, UINT32_MAX, "maxSteps"),
      bytes32Word(m.policyDefinitionHash),
      bytes32Word(m.effectivePolicyHash),
      bytes32Word(m.registryHash),
      uintWord(m.validFrom, UINT64_MAX, "validFrom"),
      uintWord(m.deadline, UINT64_MAX, "deadline"),
      uintWord(m.nonce, UINT256_MAX, "nonce"),
    ]),
  );
}

export function hashMandateStep(s: MandateStep): Bytes32 {
  return keccak256Hex(
    concat([
      bytes32Word(MANDATE_STEP_TYPEHASH),
      bytes32Word(s.mandateDigest),
      uintWord(s.stepIndex, UINT32_MAX, "stepIndex"),
      addressWord(s.outputToken),
      uintWord(s.amountIn, UINT256_MAX, "amountIn"),
      uintWord(s.minAmountOut, UINT256_MAX, "minAmountOut"),
      addressWord(s.router),
      addressWord(s.spender),
      bytes32Word(s.calldataHash),
      bytes32Word(s.evidenceHash),
      uintWord(s.deadline, UINT64_MAX, "deadline"),
    ]),
  );
}

export function hashStepCertificate(c: StepCertificate): Bytes32 {
  return keccak256Hex(
    concat([
      bytes32Word(STEP_CERTIFICATE_TYPEHASH),
      bytes32Word(c.stepDigest),
      bytes32Word(c.evidenceHash),
      bytes32Word(c.policyDefinitionHash),
      bytes32Word(c.effectivePolicyHash),
      uintWord(c.issuedAt, UINT64_MAX, "issuedAt"),
      uintWord(c.validUntil, UINT64_MAX, "validUntil"),
      uintWord(c.signerEpoch, UINT64_MAX, "signerEpoch"),
    ]),
  );
}

/** 用户一次签署的 TradeMandate 摘要（= MandateStep.mandateDigest） */
export function mandateDigest(domain: Eip712Domain, m: TradeMandate): Bytes32 {
  return typedDataDigest(domain, hashTradeMandate(m));
}
/** 步骤摘要（= StepCertificate.stepDigest） */
export function stepDigest(domain: Eip712Domain, s: MandateStep): Bytes32 {
  return typedDataDigest(domain, hashMandateStep(s));
}
export function stepCertificateDigest(domain: Eip712Domain, c: StepCertificate): Bytes32 {
  return typedDataDigest(domain, hashStepCertificate(c));
}
