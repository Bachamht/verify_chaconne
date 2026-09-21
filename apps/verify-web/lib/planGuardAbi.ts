/** PlanGuard v2 ABI（冻结签名，D2 实现须一致；struct 字段顺序 = core contracts.ts） */
export const TRADE_MANDATE_COMPONENTS = [
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
] as const;
export const MANDATE_STEP_COMPONENTS = [
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
] as const;
export const STEP_CERT_COMPONENTS = [
  { name: "stepDigest", type: "bytes32" },
  { name: "evidenceHash", type: "bytes32" },
  { name: "policyDefinitionHash", type: "bytes32" },
  { name: "effectivePolicyHash", type: "bytes32" },
  { name: "issuedAt", type: "uint64" },
  { name: "validUntil", type: "uint64" },
  { name: "signerEpoch", type: "uint64" },
] as const;

export const PLAN_GUARD_ABI = [
  {
    type: "function",
    name: "executeStep",
    stateMutability: "payable",
    inputs: [
      { name: "m", type: "tuple", components: TRADE_MANDATE_COMPONENTS },
      { name: "mSig", type: "bytes" },
      { name: "outputSet", type: "address[]" },
      { name: "s", type: "tuple", components: MANDATE_STEP_COMPONENTS },
      { name: "c", type: "tuple", components: STEP_CERT_COMPONENTS },
      { name: "cSig", type: "bytes" },
      { name: "routerCalldata", type: "bytes" },
    ],
    outputs: [
      { name: "spent", type: "uint256" },
      { name: "received", type: "uint256" },
      { name: "refunded", type: "uint256" },
    ],
  },
  { type: "function", name: "revokeMandate", stateMutability: "nonpayable", inputs: [{ name: "m", type: "tuple", components: TRADE_MANDATE_COMPONENTS }], outputs: [] },
  { type: "function", name: "cancelMandateNonce", stateMutability: "nonpayable", inputs: [{ name: "nonce", type: "uint256" }], outputs: [] },
  {
    type: "function",
    name: "mandateState",
    stateMutability: "view",
    inputs: [{ name: "digest", type: "bytes32" }],
    outputs: [
      { name: "spent", type: "uint256" },
      { name: "steps", type: "uint32" },
      { name: "revoked", type: "bool" },
    ],
  },
  {
    type: "event",
    name: "MandateStep",
    inputs: [
      { name: "owner", type: "address", indexed: true },
      { name: "mandateDigest", type: "bytes32", indexed: true },
      { name: "stepIndex", type: "uint32", indexed: true },
      { name: "outputToken", type: "address", indexed: false },
      { name: "amountIn", type: "uint256", indexed: false },
      { name: "spent", type: "uint256", indexed: false },
      { name: "received", type: "uint256", indexed: false },
      { name: "refunded", type: "uint256", indexed: false },
      { name: "evidenceHash", type: "bytes32", indexed: false },
      { name: "executor", type: "address", indexed: false },
    ],
  },
] as const;

export const PLANGUARD_ADDRESS = (process.env["NEXT_PUBLIC_PLANGUARD_ADDRESS"] ?? "") as `0x${string}` | "";
