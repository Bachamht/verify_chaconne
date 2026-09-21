/**
 * PlanGuard v2 ABI —— 由 packages/verify-contracts/abi/ChaconneVerifyPlanGuard.json 生成（Lane D2 编译产物，
 * 只保留执行者需要的函数/事件与全部自定义错误；test/planGuardAbi.test.ts 断言与该 JSON 一致，漂移即测试失败）。
 * executeStep(TradeMandate m, bytes mandateSig, address[] outputSet, Step s, StepCertificate c, bytes certSig, bytes routerCalldata)
 *   - outputSet 必须严格升序（uint160）、非空，keccak256(concat20(outputSet)) == m.outputSetHash（与 core outputSetHash 一致）
 *   - s.stepIndex 必须等于链上 mandateState(digest).steps
 *   - 输入代币由合约从 m.owner 拉取：owner 需事先对 PlanGuard 精确授权 amountIn（执行后授权应为 0）
 */
export const PLAN_GUARD_ABI = [
  {
    "type": "function",
    "name": "cancelMandateNonce",
    "inputs": [
      {
        "name": "nonce",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "certificateDigest",
    "inputs": [
      {
        "name": "c",
        "type": "tuple",
        "internalType": "struct ChaconneVerifyPlanGuard.StepCertificate",
        "components": [
          {
            "name": "stepDigest",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "evidenceHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "policyDefinitionHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "effectivePolicyHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "issuedAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "validUntil",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "signerEpoch",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "computeOutputSetHash",
    "inputs": [
      {
        "name": "outputSet",
        "type": "address[]",
        "internalType": "address[]"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "pure"
  },
  {
    "type": "function",
    "name": "domainSeparator",
    "inputs": [],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "executeStep",
    "inputs": [
      {
        "name": "m",
        "type": "tuple",
        "internalType": "struct ChaconneVerifyPlanGuard.TradeMandate",
        "components": [
          {
            "name": "owner",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "recipient",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "inputToken",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "outputSetHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "budgetCap",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "perStepCap",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "maxSteps",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "policyDefinitionHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "effectivePolicyHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "registryHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "validFrom",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "deadline",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "nonce",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      },
      {
        "name": "mandateSig",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "outputSet",
        "type": "address[]",
        "internalType": "address[]"
      },
      {
        "name": "s",
        "type": "tuple",
        "internalType": "struct ChaconneVerifyPlanGuard.Step",
        "components": [
          {
            "name": "mandateDigest",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "stepIndex",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "outputToken",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "amountIn",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "minAmountOut",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "router",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "spender",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "calldataHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "evidenceHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "deadline",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      },
      {
        "name": "c",
        "type": "tuple",
        "internalType": "struct ChaconneVerifyPlanGuard.StepCertificate",
        "components": [
          {
            "name": "stepDigest",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "evidenceHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "policyDefinitionHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "effectivePolicyHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "issuedAt",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "validUntil",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "signerEpoch",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      },
      {
        "name": "certSig",
        "type": "bytes",
        "internalType": "bytes"
      },
      {
        "name": "routerCalldata",
        "type": "bytes",
        "internalType": "bytes"
      }
    ],
    "outputs": [
      {
        "name": "spent",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "received",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "refunded",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "payable"
  },
  {
    "type": "function",
    "name": "inputShortfallTolerance",
    "inputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "uint256",
        "internalType": "uint256"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "mandateDigest",
    "inputs": [
      {
        "name": "m",
        "type": "tuple",
        "internalType": "struct ChaconneVerifyPlanGuard.TradeMandate",
        "components": [
          {
            "name": "owner",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "recipient",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "inputToken",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "outputSetHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "budgetCap",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "perStepCap",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "maxSteps",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "policyDefinitionHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "effectivePolicyHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "registryHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "validFrom",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "deadline",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "nonce",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "mandateState",
    "inputs": [
      {
        "name": "digest",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "outputs": [
      {
        "name": "spent",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "steps",
        "type": "uint32",
        "internalType": "uint32"
      },
      {
        "name": "revoked",
        "type": "bool",
        "internalType": "bool"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "revokeMandate",
    "inputs": [
      {
        "name": "m",
        "type": "tuple",
        "internalType": "struct ChaconneVerifyPlanGuard.TradeMandate",
        "components": [
          {
            "name": "owner",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "recipient",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "inputToken",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "outputSetHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "budgetCap",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "perStepCap",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "maxSteps",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "policyDefinitionHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "effectivePolicyHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "registryHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "validFrom",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "deadline",
            "type": "uint64",
            "internalType": "uint64"
          },
          {
            "name": "nonce",
            "type": "uint256",
            "internalType": "uint256"
          }
        ]
      }
    ],
    "outputs": [],
    "stateMutability": "nonpayable"
  },
  {
    "type": "function",
    "name": "signerOfEpoch",
    "inputs": [
      {
        "name": "",
        "type": "uint64",
        "internalType": "uint64"
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "address",
        "internalType": "address"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "stepDigest",
    "inputs": [
      {
        "name": "s",
        "type": "tuple",
        "internalType": "struct ChaconneVerifyPlanGuard.Step",
        "components": [
          {
            "name": "mandateDigest",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "stepIndex",
            "type": "uint32",
            "internalType": "uint32"
          },
          {
            "name": "outputToken",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "amountIn",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "minAmountOut",
            "type": "uint256",
            "internalType": "uint256"
          },
          {
            "name": "router",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "spender",
            "type": "address",
            "internalType": "address"
          },
          {
            "name": "calldataHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "evidenceHash",
            "type": "bytes32",
            "internalType": "bytes32"
          },
          {
            "name": "deadline",
            "type": "uint64",
            "internalType": "uint64"
          }
        ]
      }
    ],
    "outputs": [
      {
        "name": "",
        "type": "bytes32",
        "internalType": "bytes32"
      }
    ],
    "stateMutability": "view"
  },
  {
    "type": "event",
    "name": "MandateRevoked",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "mandateDigest",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      }
    ],
    "anonymous": false
  },
  {
    "type": "event",
    "name": "MandateStep",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "indexed": true,
        "internalType": "address"
      },
      {
        "name": "mandateDigest",
        "type": "bytes32",
        "indexed": true,
        "internalType": "bytes32"
      },
      {
        "name": "stepIndex",
        "type": "uint32",
        "indexed": true,
        "internalType": "uint32"
      },
      {
        "name": "outputToken",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      },
      {
        "name": "amountIn",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "spent",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "received",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "refunded",
        "type": "uint256",
        "indexed": false,
        "internalType": "uint256"
      },
      {
        "name": "evidenceHash",
        "type": "bytes32",
        "indexed": false,
        "internalType": "bytes32"
      },
      {
        "name": "executor",
        "type": "address",
        "indexed": false,
        "internalType": "address"
      }
    ],
    "anonymous": false
  },
  {
    "type": "error",
    "name": "BudgetExceeded",
    "inputs": []
  },
  {
    "type": "error",
    "name": "CalldataMismatch",
    "inputs": []
  },
  {
    "type": "error",
    "name": "CertificateBindingMismatch",
    "inputs": []
  },
  {
    "type": "error",
    "name": "CertificateExpired",
    "inputs": []
  },
  {
    "type": "error",
    "name": "CertificateNotYetValid",
    "inputs": []
  },
  {
    "type": "error",
    "name": "CertificateOutlivesStep",
    "inputs": []
  },
  {
    "type": "error",
    "name": "CertificateStepMismatch",
    "inputs": []
  },
  {
    "type": "error",
    "name": "CertificateTtlTooLong",
    "inputs": []
  },
  {
    "type": "error",
    "name": "EnforcedPause",
    "inputs": []
  },
  {
    "type": "error",
    "name": "EpochDisabled",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ExpectedPause",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InputTransferExcess",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InputTransferShortfall",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InsufficientOutput",
    "inputs": [
      {
        "name": "received",
        "type": "uint256",
        "internalType": "uint256"
      },
      {
        "name": "minAmountOut",
        "type": "uint256",
        "internalType": "uint256"
      }
    ]
  },
  {
    "type": "error",
    "name": "InvalidCertificateSignature",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidMandateSignature",
    "inputs": []
  },
  {
    "type": "error",
    "name": "InvalidShortString",
    "inputs": []
  },
  {
    "type": "error",
    "name": "MandateExpired",
    "inputs": []
  },
  {
    "type": "error",
    "name": "MandateNonceAlreadyUsed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "MandateNotYetValid",
    "inputs": []
  },
  {
    "type": "error",
    "name": "MandateRevokedError",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NonZeroValue",
    "inputs": []
  },
  {
    "type": "error",
    "name": "NotMandateOwner",
    "inputs": []
  },
  {
    "type": "error",
    "name": "OutputNotInSet",
    "inputs": []
  },
  {
    "type": "error",
    "name": "OutputSetMismatch",
    "inputs": []
  },
  {
    "type": "error",
    "name": "OutputSetNotSorted",
    "inputs": []
  },
  {
    "type": "error",
    "name": "OverSpent",
    "inputs": []
  },
  {
    "type": "error",
    "name": "OwnableInvalidOwner",
    "inputs": [
      {
        "name": "owner",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "OwnableUnauthorizedAccount",
    "inputs": [
      {
        "name": "account",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "PerStepCapExceeded",
    "inputs": []
  },
  {
    "type": "error",
    "name": "PolicyDisabled",
    "inputs": []
  },
  {
    "type": "error",
    "name": "RecipientShortfall",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ReentrancyGuardReentrantCall",
    "inputs": []
  },
  {
    "type": "error",
    "name": "RegistryDisabled",
    "inputs": []
  },
  {
    "type": "error",
    "name": "RouteNotAllowed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "RouterCallFailed",
    "inputs": [
      {
        "name": "reason",
        "type": "bytes",
        "internalType": "bytes"
      }
    ]
  },
  {
    "type": "error",
    "name": "SafeERC20FailedOperation",
    "inputs": [
      {
        "name": "token",
        "type": "address",
        "internalType": "address"
      }
    ]
  },
  {
    "type": "error",
    "name": "SameToken",
    "inputs": []
  },
  {
    "type": "error",
    "name": "SelectorNotAllowed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "StepExpired",
    "inputs": []
  },
  {
    "type": "error",
    "name": "StepMandateMismatch",
    "inputs": []
  },
  {
    "type": "error",
    "name": "StepOutOfOrder",
    "inputs": [
      {
        "name": "expected",
        "type": "uint32",
        "internalType": "uint32"
      },
      {
        "name": "given",
        "type": "uint32",
        "internalType": "uint32"
      }
    ]
  },
  {
    "type": "error",
    "name": "StepsExhausted",
    "inputs": []
  },
  {
    "type": "error",
    "name": "StringTooLong",
    "inputs": [
      {
        "name": "str",
        "type": "string",
        "internalType": "string"
      }
    ]
  },
  {
    "type": "error",
    "name": "TokenNotAllowed",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ZeroAddress",
    "inputs": []
  },
  {
    "type": "error",
    "name": "ZeroAmount",
    "inputs": []
  }
] as const;

/** TS 镜像（十进制串）→ viem 参数（bigint / number） */
export function toMandateArg(m: Record<string, string>) {
  return {
    owner: m["owner"] as `0x${string}`,
    recipient: m["recipient"] as `0x${string}`,
    inputToken: m["inputToken"] as `0x${string}`,
    outputSetHash: m["outputSetHash"] as `0x${string}`,
    budgetCap: BigInt(m["budgetCap"]!),
    perStepCap: BigInt(m["perStepCap"]!),
    maxSteps: Number(m["maxSteps"]),
    policyDefinitionHash: m["policyDefinitionHash"] as `0x${string}`,
    effectivePolicyHash: m["effectivePolicyHash"] as `0x${string}`,
    registryHash: m["registryHash"] as `0x${string}`,
    validFrom: BigInt(m["validFrom"]!),
    deadline: BigInt(m["deadline"]!),
    nonce: BigInt(m["nonce"]!),
  };
}
export function toStepArg(s: Record<string, string>) {
  return {
    mandateDigest: s["mandateDigest"] as `0x${string}`,
    stepIndex: Number(s["stepIndex"]),
    outputToken: s["outputToken"] as `0x${string}`,
    amountIn: BigInt(s["amountIn"]!),
    minAmountOut: BigInt(s["minAmountOut"]!),
    router: s["router"] as `0x${string}`,
    spender: s["spender"] as `0x${string}`,
    calldataHash: s["calldataHash"] as `0x${string}`,
    evidenceHash: s["evidenceHash"] as `0x${string}`,
    deadline: BigInt(s["deadline"]!),
  };
}
export function toCertArg(c: Record<string, string>) {
  return {
    stepDigest: c["stepDigest"] as `0x${string}`,
    evidenceHash: c["evidenceHash"] as `0x${string}`,
    policyDefinitionHash: c["policyDefinitionHash"] as `0x${string}`,
    effectivePolicyHash: c["effectivePolicyHash"] as `0x${string}`,
    issuedAt: BigInt(c["issuedAt"]!),
    validUntil: BigInt(c["validUntil"]!),
    signerEpoch: BigInt(c["signerEpoch"]!),
  };
}

/** 执行者传入的 outputSet 规则（= 合约检查）：严格升序（uint160）、去重、非空 */
export function normalizeOutputSet(tokens: readonly string[]): `0x${string}`[] {
  const uniq = [...new Set(tokens.map((t) => t.toLowerCase()))];
  if (uniq.length === 0) throw new Error("outputSet empty");
  return uniq.sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : BigInt(a) > BigInt(b) ? 1 : 0)) as `0x${string}`[];
}
