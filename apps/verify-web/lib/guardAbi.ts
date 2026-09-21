// 复制自 apps/verify-service/src/execution/guardAbi.ts（同一份 ABI；Lane I 集成时改为共享包）
/**
 * Guard 合约接口（与 packages/verify-contracts 的 ChaconneVerifyGuard 保持一致；Lane D 发布 ABI 后以其为准）。
 * 结构字段顺序 = EIP-712 类型顺序（core/verify/eip712.ts），一经部署冻结。
 */
export const GUARD_ABI = [
  {
    type: "function",
    name: "execute",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "intent",
        type: "tuple",
        components: [
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
      },
      { name: "intentSignature", type: "bytes" },
      {
        name: "cert",
        type: "tuple",
        components: [
          { name: "intentDigest", type: "bytes32" },
          { name: "evidenceHash", type: "bytes32" },
          { name: "policyDefinitionHash", type: "bytes32" },
          { name: "effectivePolicyHash", type: "bytes32" },
          { name: "issuedAt", type: "uint64" },
          { name: "validUntil", type: "uint64" },
          { name: "signerEpoch", type: "uint64" },
        ],
      },
      { name: "certSignature", type: "bytes" },
      { name: "routerCalldata", type: "bytes" },
    ],
    outputs: [
      { name: "spent", type: "uint256" },
      { name: "received", type: "uint256" },
      { name: "refunded", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "cancelNonce",
    stateMutability: "nonpayable",
    inputs: [{ name: "nonce", type: "uint256" }],
    outputs: [],
  },
  {
    type: "function",
    name: "nonceUsed",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "nonce", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "event",
    name: "GuardedExecution",
    inputs: [
      { name: "owner", type: "address", indexed: true },
      { name: "recipient", type: "address", indexed: true },
      { name: "nonce", type: "uint256", indexed: true },
      { name: "intentDigest", type: "bytes32", indexed: false },
      { name: "evidenceHash", type: "bytes32", indexed: false },
      { name: "policyDefinitionHash", type: "bytes32", indexed: false },
      { name: "effectivePolicyHash", type: "bytes32", indexed: false },
      { name: "router", type: "address", indexed: false },
      { name: "amountIn", type: "uint256", indexed: false },
      { name: "spent", type: "uint256", indexed: false },
      { name: "received", type: "uint256", indexed: false },
      { name: "refunded", type: "uint256", indexed: false },
    ],
  },
] as const;
