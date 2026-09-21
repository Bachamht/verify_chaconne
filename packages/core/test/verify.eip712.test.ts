/**
 * EIP-712 双实现互检：本项目手写编码 vs viem.hashTypedData（§0 反幻觉：双实现互检）。
 */
import { describe, expect, it } from "vitest";
import { hashTypedData, keccak256, toBytes } from "viem";
import {
  calldataHash,
  certificateDigest,
  domainSeparator,
  EIP712_TYPES,
  hashTradeIntent,
  hashVerificationCertificate,
  intentDigest,
  makeDomain,
  TRADE_INTENT_TYPEHASH,
  VERIFICATION_CERTIFICATE_TYPEHASH,
  type TradeIntent,
  type VerificationCertificate,
} from "../src/verify";

const GUARD = "0x4444444444444444444444444444444444444444" as const;
const domain = makeDomain(196, GUARD);

const intent: TradeIntent = {
  owner: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  recipient: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  inputToken: "0x1111111111111111111111111111111111111111",
  outputToken: "0x2222222222222222222222222222222222222222",
  amountIn: "100000000",
  minAmountOut: "398000000000000000",
  router: "0x5555555555555555555555555555555555555555",
  spender: "0x6666666666666666666666666666666666666666",
  calldataHash: keccak256("0xdeadbeef"),
  policyDefinitionHash: `0x${"01".repeat(32)}`,
  effectivePolicyHash: `0x${"02".repeat(32)}`,
  registryHash: `0x${"03".repeat(32)}`,
  evidenceHash: `0x${"04".repeat(32)}`,
  nonce: "7",
  deadline: "1789000060",
};

const toViemIntent = (i: TradeIntent) => ({
  ...i,
  amountIn: BigInt(i.amountIn),
  minAmountOut: BigInt(i.minAmountOut),
  nonce: BigInt(i.nonce),
  deadline: BigInt(i.deadline),
});

describe("EIP-712 编码 vs viem", () => {
  it("TradeIntent 摘要一致", () => {
    const ours = intentDigest(domain, intent);
    const theirs = hashTypedData({
      domain: { name: domain.name, version: domain.version, chainId: domain.chainId, verifyingContract: domain.verifyingContract },
      types: EIP712_TYPES,
      primaryType: "TradeIntent",
      message: toViemIntent(intent),
    });
    expect(ours).toBe(theirs);
  });

  it("VerificationCertificate 摘要一致，且与 intent 摘要绑定", () => {
    const cert: VerificationCertificate = {
      intentDigest: intentDigest(domain, intent),
      evidenceHash: intent.evidenceHash,
      policyDefinitionHash: intent.policyDefinitionHash,
      effectivePolicyHash: intent.effectivePolicyHash,
      issuedAt: "1789000000",
      validUntil: "1789000060",
      signerEpoch: "1",
    };
    const ours = certificateDigest(domain, cert);
    const theirs = hashTypedData({
      domain: { name: domain.name, version: domain.version, chainId: domain.chainId, verifyingContract: domain.verifyingContract },
      types: EIP712_TYPES,
      primaryType: "VerificationCertificate",
      message: {
        ...cert,
        issuedAt: BigInt(cert.issuedAt),
        validUntil: BigInt(cert.validUntil),
        signerEpoch: BigInt(cert.signerEpoch),
      },
    });
    expect(ours).toBe(theirs);
    // 不同类型哈希，防角色混淆
    expect(TRADE_INTENT_TYPEHASH).not.toBe(VERIFICATION_CERTIFICATE_TYPEHASH);
    expect(hashTradeIntent(intent)).not.toBe(hashVerificationCertificate(cert));
  });

  it("G-03 跨链 / 跨 Guard 地址摘要不同；G-05 改任一字段摘要不同", () => {
    const base = intentDigest(domain, intent);
    expect(intentDigest(makeDomain(1952, GUARD), intent)).not.toBe(base);
    expect(intentDigest(makeDomain(196, "0x7777777777777777777777777777777777777777"), intent)).not.toBe(base);
    for (const k of Object.keys(intent) as Array<keyof TradeIntent>) {
      const mutated = { ...intent } as Record<keyof TradeIntent, string>;
      const v = mutated[k];
      if (/^0x[0-9a-f]{40}$/.test(v)) mutated[k] = "0x9999999999999999999999999999999999999999";
      else if (/^0x[0-9a-f]{64}$/.test(v)) mutated[k] = `0x${"ee".repeat(32)}`;
      else mutated[k] = (BigInt(v) + 1n).toString();
      expect(intentDigest(domain, mutated as TradeIntent), `field ${k}`).not.toBe(base);
    }
  });

  it("域分隔符与 viem 计算一致（通过完整摘要间接验证）+ calldataHash", () => {
    expect(domainSeparator(domain)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(calldataHash("0xdeadbeef")).toBe(keccak256(toBytes("0xdeadbeef")));
  });

  it("uint64 越界与非法地址被拒", () => {
    expect(() => hashTradeIntent({ ...intent, deadline: (1n << 64n).toString() })).toThrow(/越界/);
    expect(() => hashTradeIntent({ ...intent, owner: "0x12" as `0x${string}` })).toThrow(/非法地址/);
  });
});
