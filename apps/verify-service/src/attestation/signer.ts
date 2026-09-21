/**
 * 证明签名身份（D-080 例外范围内唯一的一把私钥）。
 * 只暴露 signCertificate()：签 EIP-712 VerificationCertificate；不提供任意消息/交易签名接口。
 * 无私钥时 = 禁用签发（服务仍可出报告，但 prepare-execution 返回 503 attestation_disabled）。
 */
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import {
  certificateDigest,
  EIP712_TYPES,
  EIP712_TYPES_V2,
  makeDomain,
  makePlanGuardDomain,
  stepCertificateDigest,
  type Bytes32,
  type EvmAddress,
  type StepCertificate,
  type VerificationCertificate,
} from "@chaconne/core/verify";

export interface AttestationSigner {
  readonly address: EvmAddress;
  readonly epoch: number;
  signCertificate(chainId: number, guard: EvmAddress, cert: VerificationCertificate): Promise<{ signature: `0x${string}`; digest: Bytes32 }>;
  /** v2：PlanGuard 步骤证书（EIP-712，domain ChaconneVerifyPlanGuard） */
  signStepCertificate(chainId: number, planGuard: EvmAddress, cert: StepCertificate): Promise<{ signature: `0x${string}`; digest: Bytes32 }>;
  /** v2：证据包哈希的 EIP-191 签名（signMessage raw bytes32）；只签 bundleHash，不是任意消息接口 */
  signBundleHash(bundleHash: Bytes32): Promise<`0x${string}`>;
}

export function createAttestationSigner(privateKey: string, epoch: number): AttestationSigner {
  const account: PrivateKeyAccount = privateKeyToAccount(privateKey as `0x${string}`);
  return {
    address: account.address.toLowerCase() as EvmAddress,
    epoch,
    async signCertificate(chainId, guard, cert) {
      const domain = makeDomain(chainId, guard);
      const signature = await account.signTypedData({
        domain: { name: domain.name, version: domain.version, chainId: domain.chainId, verifyingContract: domain.verifyingContract },
        types: EIP712_TYPES,
        primaryType: "VerificationCertificate",
        message: {
          intentDigest: cert.intentDigest,
          evidenceHash: cert.evidenceHash,
          policyDefinitionHash: cert.policyDefinitionHash,
          effectivePolicyHash: cert.effectivePolicyHash,
          issuedAt: BigInt(cert.issuedAt),
          validUntil: BigInt(cert.validUntil),
          signerEpoch: BigInt(cert.signerEpoch),
        },
      });
      return { signature, digest: certificateDigest(domain, cert) };
    },
    async signStepCertificate(chainId, planGuard, cert) {
      const domain = makePlanGuardDomain(chainId, planGuard);
      const signature = await account.signTypedData({
        domain: { name: domain.name, version: domain.version, chainId: domain.chainId, verifyingContract: domain.verifyingContract },
        types: EIP712_TYPES_V2,
        primaryType: "StepCertificate",
        message: {
          stepDigest: cert.stepDigest,
          evidenceHash: cert.evidenceHash,
          policyDefinitionHash: cert.policyDefinitionHash,
          effectivePolicyHash: cert.effectivePolicyHash,
          issuedAt: BigInt(cert.issuedAt),
          validUntil: BigInt(cert.validUntil),
          signerEpoch: BigInt(cert.signerEpoch),
        },
      });
      return { signature, digest: stepCertificateDigest(domain, cert) };
    },
    async signBundleHash(bundleHash) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(bundleHash)) throw new Error("bundleHash 必须是 bytes32");
      return account.signMessage({ message: { raw: bundleHash } });
    },
  };
}
