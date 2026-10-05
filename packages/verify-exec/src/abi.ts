/**
 * ABI：PlanGuard v2 以编译产物为准（packages/verify-contracts/abi/ChaconneVerifyPlanGuard.json，与 verify-service / verify-mcp 同源）；
 * ERC-20 只取执行路径用到的读函数、approve、EIP-2612 permit 与 Approval 事件。
 */
import { parseAbi, type Abi, type Hex } from "viem";
import artifact from "../../verify-contracts/abi/ChaconneVerifyPlanGuard.json";

export const PLANGUARD_ABI = (artifact as { abi: unknown }).abi as Abi;

export const TOKEN_ABI = parseAbi([
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address owner) view returns (uint256)",
  "function nonces(address owner) view returns (uint256)",
  "function approve(address spender, uint256 value) returns (bool)",
  "function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
]);

export const MANDATE_STATE_ABI = parseAbi(["function mandateState(bytes32 digest) view returns (uint256 spent, uint32 steps, bool revoked)"]);

/** executeStep 的 4 字节选择器（由 ABI 现算，见 txBuild.ts） */
export const APPROVE_SELECTOR: Hex = "0x095ea7b3";

/** TS 镜像（十进制串）→ viem 参数（bigint / number） */
export function toMandateArg(m: Record<string, string>) {
  return {
    owner: m["owner"] as Hex,
    recipient: m["recipient"] as Hex,
    inputToken: m["inputToken"] as Hex,
    outputSetHash: m["outputSetHash"] as Hex,
    budgetCap: BigInt(m["budgetCap"]!),
    perStepCap: BigInt(m["perStepCap"]!),
    maxSteps: Number(m["maxSteps"]),
    policyDefinitionHash: m["policyDefinitionHash"] as Hex,
    effectivePolicyHash: m["effectivePolicyHash"] as Hex,
    registryHash: m["registryHash"] as Hex,
    validFrom: BigInt(m["validFrom"]!),
    deadline: BigInt(m["deadline"]!),
    nonce: BigInt(m["nonce"]!),
  };
}
export function toStepArg(s: Record<string, string>) {
  return {
    mandateDigest: s["mandateDigest"] as Hex,
    stepIndex: Number(s["stepIndex"]),
    outputToken: s["outputToken"] as Hex,
    amountIn: BigInt(s["amountIn"]!),
    minAmountOut: BigInt(s["minAmountOut"]!),
    router: s["router"] as Hex,
    spender: s["spender"] as Hex,
    calldataHash: s["calldataHash"] as Hex,
    evidenceHash: s["evidenceHash"] as Hex,
    deadline: BigInt(s["deadline"]!),
  };
}
export function toCertArg(c: Record<string, string>) {
  return {
    stepDigest: c["stepDigest"] as Hex,
    evidenceHash: c["evidenceHash"] as Hex,
    policyDefinitionHash: c["policyDefinitionHash"] as Hex,
    effectivePolicyHash: c["effectivePolicyHash"] as Hex,
    issuedAt: BigInt(c["issuedAt"]!),
    validUntil: BigInt(c["validUntil"]!),
    signerEpoch: BigInt(c["signerEpoch"]!),
  };
}

/** 合约要求的 outputSet：uint160 严格升序、去重、非空 */
export function normalizeOutputSet(tokens: readonly string[]): Hex[] {
  const uniq = [...new Set(tokens.map((t) => t.toLowerCase()))];
  if (uniq.length === 0) throw new Error("outputSet empty");
  return uniq.sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0)) as Hex[];
}
