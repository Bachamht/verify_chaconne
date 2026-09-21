/**
 * PlanGuard v2 ABI：以 Lane D2 编译产物为准（packages/verify-contracts/abi/ChaconneVerifyPlanGuard.json）。
 * 服务只用 executeStep 参数编码（给执行者）与 MandateStep 事件解码（回执核实）。
 * executeStep(m, mandateSig, outputSet[], s, c, certSig, routerCalldata)；outputSet 按 uint160 严格升序且唯一。
 */
import artifact from "../../../../packages/verify-contracts/abi/ChaconneVerifyPlanGuard.json";

export const PLANGUARD_ABI = artifact.abi as unknown as readonly [
  {
    type: "event";
    name: "MandateStep";
    inputs: readonly [
      { name: "owner"; type: "address"; indexed: true },
      { name: "mandateDigest"; type: "bytes32"; indexed: true },
      { name: "stepIndex"; type: "uint32"; indexed: true },
      { name: "outputToken"; type: "address"; indexed: false },
      { name: "amountIn"; type: "uint256"; indexed: false },
      { name: "spent"; type: "uint256"; indexed: false },
      { name: "received"; type: "uint256"; indexed: false },
      { name: "refunded"; type: "uint256"; indexed: false },
      { name: "evidenceHash"; type: "bytes32"; indexed: false },
      { name: "executor"; type: "address"; indexed: false },
    ];
  },
];

/** 合约要求的 outputSet 顺序：uint160 严格升序、唯一 */
export function sortOutputSet(tokens: readonly `0x${string}`[]): `0x${string}`[] {
  return [...new Set(tokens.map((t) => t.toLowerCase() as `0x${string}`))].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0));
}
