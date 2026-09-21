/** 证据包验证（MCP/CLI 版，委托 core verifyBundleOffline + viem 验签）：合法包全通过；篡改 → 指出失败层；CLI 退出码 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import type { Hex } from "viem";
import { buildReport, bundleHash, EIP712_TYPES, EIP712_TYPES_V2, intentDigest, makeDomain, makePlanGuardDomain, mandateDigest, outputSetHash, stepDigest, validateCreateJob, type EvidenceBundle, type MandateStep, type StepCertificate, type TradeIntent, type TradeMandate, type VerificationCertificate } from "@chaconne/core/verify";
import { FIXTURE_CHAIN_ID, FIXTURE_STABLE, FIXTURE_STOCK, fixtureJob, fixtureRegistry, liveHappyEvidence, resetFixtureIds, T_REGULAR } from "@chaconne/core/verify/fixtures";
import { verifyBundle } from "../src/bundleVerify";
const TSX = createRequire(import.meta.url).resolve("tsx/cli");

/** 公开的 anvil 测试账户 #0 / #1（仅测试） */
const SIGNER = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const OWNER = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const GUARD = "0x4444444444444444444444444444444444444444" as const;
const PLAN_GUARD = "0x5555555555555555555555555555555555555555" as const;
const H = (b: string) => ("0x" + b.repeat(32)) as Hex;
const big = (o: Record<string, string>, keys: string[]) => Object.fromEntries(Object.entries(o).map(([k, x]) => [k, keys.includes(k) ? BigInt(x) : x]));

async function makeBundle(): Promise<EvidenceBundle> {
  resetFixtureIds();
  const v = validateCreateJob(fixtureJob({ ownerAddress: OWNER.address, recipientAddress: OWNER.address }));
  if (!v.ok) throw new Error("job");
  const evidence = liveHappyEvidence();
  const registry = fixtureRegistry();
  const report = buildReport({ jobId: "job_b", reportVersion: 1, job: v.job, policy: v.policy, registry, evidence, evaluatedAt: T_REGULAR });
  const domain = makeDomain(FIXTURE_CHAIN_ID, GUARD);
  const intent: TradeIntent = { owner: OWNER.address, recipient: OWNER.address, inputToken: FIXTURE_STABLE, outputToken: FIXTURE_STOCK, amountIn: "100000000", minAmountOut: report.normalizedQuote!.minOutRaw, router: "0x5555555555555555555555555555555555555555", spender: "0x6666666666666666666666666666666666666666", calldataHash: H("77"), policyDefinitionHash: report.policyDefinitionHash, effectivePolicyHash: report.effectivePolicyHash, registryHash: report.registryHash, evidenceHash: report.evidenceHash, nonce: "1", deadline: "1789909931" };
  const cert: VerificationCertificate = { intentDigest: intentDigest(domain, intent), evidenceHash: report.evidenceHash, policyDefinitionHash: report.policyDefinitionHash, effectivePolicyHash: report.effectivePolicyHash, issuedAt: "1789909871", validUntil: "1789909931", signerEpoch: "1" };
  const vd = { name: "ChaconneVerifyGuard", version: "1", chainId: FIXTURE_CHAIN_ID, verifyingContract: GUARD } as const;
  const intentSig = await OWNER.signTypedData({ domain: vd, types: EIP712_TYPES, primaryType: "TradeIntent", message: big(intent as unknown as Record<string, string>, ["amountIn", "minAmountOut", "nonce", "deadline"]) as never });
  const certSig = await SIGNER.signTypedData({ domain: vd, types: EIP712_TYPES, primaryType: "VerificationCertificate", message: big(cert as unknown as Record<string, string>, ["issuedAt", "validUntil", "signerEpoch"]) as never });
  // v2 mandate + step
  const pd = makePlanGuardDomain(FIXTURE_CHAIN_ID, PLAN_GUARD);
  const pvd = { name: "ChaconneVerifyPlanGuard", version: "1", chainId: FIXTURE_CHAIN_ID, verifyingContract: PLAN_GUARD } as const;
  const mandate: TradeMandate = { owner: OWNER.address, recipient: OWNER.address, inputToken: FIXTURE_STABLE, outputSetHash: outputSetHash([FIXTURE_STOCK]), budgetCap: "200000000", perStepCap: "100000000", maxSteps: "2", policyDefinitionHash: report.policyDefinitionHash, effectivePolicyHash: report.effectivePolicyHash, registryHash: report.registryHash, validFrom: "1", deadline: "9999999999", nonce: "9" };
  const md = mandateDigest(pd, mandate);
  const mandateSig = await OWNER.signTypedData({ domain: pvd, types: EIP712_TYPES_V2, primaryType: "TradeMandate", message: big(mandate as unknown as Record<string, string>, ["budgetCap", "perStepCap", "validFrom", "deadline", "nonce"]) as never });
  const step: MandateStep = { mandateDigest: md, stepIndex: "0", outputToken: FIXTURE_STOCK, amountIn: "100000000", minAmountOut: report.normalizedQuote!.minOutRaw, router: intent.router, spender: intent.spender, calldataHash: H("77"), evidenceHash: report.evidenceHash, deadline: "9999999999" };
  const sd = stepDigest(pd, step);
  const scert: StepCertificate = { stepDigest: sd, evidenceHash: report.evidenceHash, policyDefinitionHash: report.policyDefinitionHash, effectivePolicyHash: report.effectivePolicyHash, issuedAt: "1789909871", validUntil: "1789909931", signerEpoch: "1" };
  const scertSig = await SIGNER.signTypedData({ domain: pvd, types: EIP712_TYPES_V2, primaryType: "StepCertificate", message: big(scert as unknown as Record<string, string>, ["issuedAt", "validUntil", "signerEpoch"]) as never });
  const body: Omit<EvidenceBundle, "bundleHash" | "bundleSignature"> = {
    schemaVersion: "1", kind: "mandate", id: "mnd_b", exportedAt: T_REGULAR, chainId: FIXTURE_CHAIN_ID, job: v.job, registryVersion: registry.version, registry: registry.entries, registryHash: report.registryHash, policy: v.policy.definition, effectivePolicy: v.policy, evidence, reports: [report],
    certificates: [
      { typedData: { domain: vd, types: { VerificationCertificate: [...EIP712_TYPES.VerificationCertificate] }, primaryType: "VerificationCertificate", message: cert }, signature: certSig, signer: SIGNER.address, epoch: 1 },
      { typedData: { domain: pvd, types: { StepCertificate: [...EIP712_TYPES_V2.StepCertificate] }, primaryType: "StepCertificate", message: scert }, signature: scertSig, signer: SIGNER.address, epoch: 1 },
    ],
    intents: [{ typedData: { domain: vd, types: { TradeIntent: [...EIP712_TYPES.TradeIntent] }, primaryType: "TradeIntent", message: intent }, signature: intentSig }],
    mandate: { typedData: { domain: pvd, types: { TradeMandate: [...EIP712_TYPES_V2.TradeMandate] }, primaryType: "TradeMandate", message: mandate }, signature: mandateSig, steps: [{ stepIndex: "0", state: "CONFIRMED", step, stepDigest: sd, certificate: scert, certificateSignature: scertSig, txHash: null, receiptSummary: null }] },
    executions: [{ attemptId: "exe_1", chainId: FIXTURE_CHAIN_ID }],
    bill: { serviceFees: [], principal: [], gas: [], selfPayment: true },
  };
  const h = bundleHash(body);
  return { ...body, bundleHash: h, bundleSignature: await SIGNER.signMessage({ message: { raw: h } }) };
}
const failed = async (b: EvidenceBundle) => (await verifyBundle(b, { expectedSigner: SIGNER.address })).checks.filter((c) => !c.ok).map((c) => c.id);

describe("verifyBundle (MCP/CLI)", () => {
  it("合法包：全部通过，含签名层（viem 注入，非 skipped）", async () => {
    const r = await verifyBundle(await makeBundle(), { expectedSigner: SIGNER.address });
    expect(r.checks.filter((c) => !c.ok)).toEqual([]);
    expect(r.ok).toBe(true);
    for (const id of ["bundle_signature", "cert_0_signature", "cert_1_signature", "intent_0_signature", "mandate_signature", "mandate_step_0_cert_signature", "report_v1_rules"]) {
      const c = r.checks.find((x) => x.id === id)!;
      expect(c.detail).not.toMatch(/skipped/);
    }
  });

  it("篡改 → 指出层：意图金额 / 步骤金额 / 证书签名 / 包签名 / 授权预算 / 证据数值", async () => {
    const base = await makeBundle();
    const clone = () => JSON.parse(JSON.stringify(base)) as EvidenceBundle;
    let b = clone();
    (b.intents![0]!.typedData as { message: TradeIntent }).message.amountIn = "6000000";
    let f = await failed(b);
    expect(f).toEqual(expect.arrayContaining(["bundle_hash", "intent_0_signature", "cert_0_intent_digest"]));
    b = clone();
    b.mandate!.steps[0]!.step.amountIn = "6000000";
    f = await failed(b);
    expect(f).toEqual(expect.arrayContaining(["mandate_step_0_digest", "cert_1_step_digest"]));
    b = clone();
    b.certificates[0]!.signature = ("0x" + "11".repeat(65)) as Hex;
    f = await failed(b);
    expect(f).toContain("cert_0_signature");
    b = clone();
    b.bundleSignature = await OWNER.signMessage({ message: { raw: b.bundleHash } });
    expect(await failed(b)).toEqual(["bundle_signature"]);
    b = clone();
    (b.mandate!.typedData as { message: TradeMandate }).message.budgetCap = "999";
    f = await failed(b);
    expect(f).toEqual(expect.arrayContaining(["mandate_digest", "mandate_signature"]));
    b = clone();
    (b.evidence.find((e) => e.payload.kind === "okx_quote")!.payload as unknown as { expectedOutRaw: string }).expectedOutRaw = "1";
    f = await failed(b);
    expect(f).toEqual(expect.arrayContaining(["report_v1_evidence_hash", "report_v1_rules"]));
    const r = await verifyBundle(b);
    expect(r.failedLayers).toEqual(expect.arrayContaining(["bundle", "report"]));
  });

  it("CLI：合法 → 退出 0 并输出清单；篡改 → 退出 1", async () => {
    const bundle = await makeBundle();
    const dir = mkdtempSync(join(tmpdir(), "bundle-"));
    const good = join(dir, "good.json");
    writeFileSync(good, JSON.stringify(bundle));
    const out = execFileSync(process.execPath, [TSX, join(__dirname, "..", "src", "verifyBundleCli.ts"), good, "--signer", SIGNER.address], { encoding: "utf8" });
    const parsed = JSON.parse(out) as { ok: boolean; summary: { failed: number } };
    expect(parsed.ok).toBe(true);
    expect(parsed.summary.failed).toBe(0);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ ...bundle, bundleHash: H("ff") }));
    let code = 0;
    try {
      execFileSync(process.execPath, [TSX, join(__dirname, "..", "src", "verifyBundleCli.ts"), bad], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      code = (e as { status: number }).status;
    }
    expect(code).toBe(1);
  }, 60_000);
});
