/** 证据包（v5 W3 · V-01～V-04）：离线哈希重算、签名验证（注入 viem）、规则重算、篡改任一字段 → 指出失败层 */
import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { verifyMessage, verifyTypedData } from "viem";
import {
  buildLadder,
  buildPlanReport,
  buildReport,
  bundleHash,
  EIP712_TYPES,
  EIP712_TYPES_V2,
  intentDigest,
  makeDomain,
  makePlanGuardDomain,
  mandateDigest,
  outputSetHash,
  stepDigest,
  validateCreateJob,
  verifyBundleOffline,
  type EvidenceBundle,
  type MandateStep,
  type StepCertificate,
  type TradeIntent,
  type TradeMandate,
  type VerificationCertificate,
  type VerifyBundleOptions,
} from "../src/verify";
import { FIXTURE_CHAIN_ID, FIXTURE_OWNER, FIXTURE_RECIPIENT, FIXTURE_STABLE, FIXTURE_STABLE_KEY, FIXTURE_STOCK, FIXTURE_STOCK_KEY, fixtureJob, fixtureRegistry, liveHappyEvidence, quoteEvidence, resetFixtureIds, T_REGULAR } from "../src/verify/fixtures";

/** 公开的 anvil 测试账户 #0 / #1（仅测试） */
const SIGNER = privateKeyToAccount("0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80");
const OWNER = privateKeyToAccount("0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d");
const GUARD = "0x4444444444444444444444444444444444444444" as const;
const H = (b: string) => ("0x" + b.repeat(32)) as `0x${string}`;

const opts: VerifyBundleOptions = {
  verifyTypedData: ({ address, typedData, signature }) => verifyTypedData({ address, domain: typedData.domain, types: typedData.types, primaryType: typedData.primaryType, message: typedData.message, signature } as never),
  verifyMessage: ({ address, raw, signature }) => verifyMessage({ address, message: { raw }, signature }),
};

async function jobBundle(): Promise<EvidenceBundle> {
  resetFixtureIds();
  const v = validateCreateJob(fixtureJob({ ownerAddress: OWNER.address, recipientAddress: OWNER.address }));
  if (!v.ok) throw new Error("job");
  const evidence = liveHappyEvidence();
  const registry = fixtureRegistry();
  const report = buildReport({ jobId: "job_b", reportVersion: 1, job: v.job, policy: v.policy, registry, evidence, evaluatedAt: T_REGULAR });
  const domain = makeDomain(FIXTURE_CHAIN_ID, GUARD);
  const intent: TradeIntent = {
    owner: OWNER.address,
    recipient: OWNER.address,
    inputToken: FIXTURE_STABLE,
    outputToken: FIXTURE_STOCK,
    amountInRaw: "100000000",
    minAmountOut: report.normalizedQuote!.minOutRaw,
    router: "0x5555555555555555555555555555555555555555",
    spender: "0x6666666666666666666666666666666666666666",
    calldataHash: H("77"),
    policyDefinitionHash: report.policyDefinitionHash,
    effectivePolicyHash: report.effectivePolicyHash,
    registryHash: report.registryHash,
    evidenceHash: report.evidenceHash,
    nonce: "1",
    deadline: "1789909931",
  } as unknown as TradeIntent;
  (intent as unknown as { amountIn: string }).amountIn = "100000000";
  delete (intent as unknown as { amountInRaw?: string }).amountInRaw;
  const cert: VerificationCertificate = { intentDigest: intentDigest(domain, intent), evidenceHash: report.evidenceHash, policyDefinitionHash: report.policyDefinitionHash, effectivePolicyHash: report.effectivePolicyHash, issuedAt: "1789909871", validUntil: "1789909931", signerEpoch: "1" };
  const viemDomain = { name: "ChaconneVerifyGuard", version: "1", chainId: FIXTURE_CHAIN_ID, verifyingContract: GUARD } as const;
  const big = (o: Record<string, string>, keys: string[]) => Object.fromEntries(Object.entries(o).map(([k, x]) => [k, keys.includes(k) ? BigInt(x) : x]));
  const intentSig = await OWNER.signTypedData({ domain: viemDomain, types: EIP712_TYPES, primaryType: "TradeIntent", message: big(intent as unknown as Record<string, string>, ["amountIn", "minAmountOut", "nonce", "deadline"]) as never });
  const certSig = await SIGNER.signTypedData({ domain: viemDomain, types: EIP712_TYPES, primaryType: "VerificationCertificate", message: big(cert as unknown as Record<string, string>, ["issuedAt", "validUntil", "signerEpoch"]) as never });
  const body: Omit<EvidenceBundle, "bundleHash" | "bundleSignature"> = {
    schemaVersion: "1",
    kind: "job",
    id: "job_b",
    exportedAt: T_REGULAR,
    chainId: FIXTURE_CHAIN_ID,
    job: v.job,
    registryVersion: registry.version,
    registry: registry.entries,
    registryHash: report.registryHash,
    policy: v.policy.definition,
    effectivePolicy: v.policy,
    evidence,
    reports: [report],
    certificates: [{ typedData: { domain: viemDomain, types: { VerificationCertificate: [...EIP712_TYPES.VerificationCertificate] }, primaryType: "VerificationCertificate", message: cert }, signature: certSig, signer: SIGNER.address, epoch: 1 }],
    intents: [{ typedData: { domain: viemDomain, types: { TradeIntent: [...EIP712_TYPES.TradeIntent] }, primaryType: "TradeIntent", message: intent }, signature: intentSig }],
    executions: [{ attemptId: "exe_1", chainId: FIXTURE_CHAIN_ID }],
    bill: { serviceFees: [], principal: [], gas: [], selfPayment: true },
  };
  const h = bundleHash(body);
  return { ...body, bundleHash: h, bundleSignature: await SIGNER.signMessage({ message: { raw: h } }) };
}

const failing = (checks: Awaited<ReturnType<typeof verifyBundleOffline>>) => checks.filter((c) => !c.ok).map((c) => c.id);

describe("evidence bundle", () => {
  it("V-01/V-03/V-04：完整任务包全部检查通过（哈希、签名、摘要、规则重算）", async () => {
    const b = await jobBundle();
    const checks = await verifyBundleOffline(b, opts);
    expect(failing(checks)).toEqual([]);
    const ids = checks.map((c) => c.id);
    for (const id of ["bundle_hash", "bundle_signature", "evidence_raw_hash", "registry_hash", "policy_definition_hash", "effective_policy_hash", "report_v1_evidence_hash", "report_v1_rules", "cert_0_intent_digest", "cert_0_evidence_hash", "cert_0_signature", "intent_0_signature"]) expect(ids).toContain(id);
    // 未注入验证器 → 签名检查标 skipped 而不是失败
    const noSig = await verifyBundleOffline(b);
    expect(noSig.find((c) => c.id === "cert_0_signature")?.detail).toMatch(/skipped/);
  });

  it("V-02：篡改任一字段 → 指出失败层", async () => {
    const b = await jobBundle();
    const tamper = async (mut: (x: EvidenceBundle) => void) => {
      const x = JSON.parse(JSON.stringify(b)) as EvidenceBundle;
      mut(x);
      return failing(await verifyBundleOffline(x, opts));
    };
    // 改证据数值（报价输出）→ evidenceHash 与规则重算失败 + bundleHash
    expect(await tamper((x) => { (x.evidence.find((e) => e.payload.kind === "okx_quote")!.payload as { expectedOutRaw: string }).expectedOutRaw = "1"; })).toEqual(expect.arrayContaining(["bundle_hash", "report_v1_evidence_hash", "report_v1_rules"]));
    // 改报告判定 → 规则重算失败（evidenceHash 仍一致）
    const f1 = await tamper((x) => { x.reports[0]!.verdict = "rejected"; });
    expect(f1).toContain("report_v1_rules");
    expect(f1).not.toContain("report_v1_evidence_hash");
    // 改证书 evidenceHash → 与报告不匹配 + 签名失败
    expect(await tamper((x) => { (x.certificates[0]!.typedData as { message: VerificationCertificate }).message.evidenceHash = H("99"); })).toEqual(expect.arrayContaining(["cert_0_evidence_hash", "cert_0_signature"]));
    // 换 signer 地址 → 证书签名失败
    expect(await tamper((x) => { x.certificates[0]!.signer = OWNER.address; })).toContain("cert_0_signature");
    // 改意图 minAmountOut → intentDigest 不匹配 + 意图签名失败
    expect(await tamper((x) => { (x.intents![0]!.typedData as { message: { minAmountOut: string } }).message.minAmountOut = "1"; })).toEqual(expect.arrayContaining(["cert_0_intent_digest", "intent_0_signature"]));
    // 只改 bundleHash → bundle_hash + bundle_signature
    expect(await tamper((x) => { x.bundleHash = H("00"); })).toEqual(expect.arrayContaining(["bundle_hash", "bundle_signature"]));
    // 改 policy 定义 → 定义哈希失败
    expect(await tamper((x) => { x.policy.quoteMaxAgeSeconds = 999; })).toContain("policy_definition_hash");
    // 换 job（金额）→ requestHash 不匹配 → 规则层失败
    expect(await tamper((x) => { x.job!.amountInRaw = "1"; })).toContain("report_v1_rules");
    // 删证据 → evidenceHash 失败
    expect(await tamper((x) => { x.evidence.pop(); })).toContain("report_v1_evidence_hash");
  });

  it("授权计划包：mandateDigest / stepDigest / 步骤证书签名 / 授权签名；篡改步骤 → 定位到该步", async () => {
    resetFixtureIds();
    const v = validateCreateJob(fixtureJob({ ownerAddress: OWNER.address, recipientAddress: OWNER.address }));
    if (!v.ok) throw new Error("job");
    const registry = fixtureRegistry();
    const evidence = liveHappyEvidence();
    const report = buildReport({ jobId: "job_m", reportVersion: 1, job: v.job, policy: v.policy, registry, evidence, evaluatedAt: T_REGULAR });
    const PG = "0x5555555555555555555555555555555555555550" as const;
    const domain = makePlanGuardDomain(FIXTURE_CHAIN_ID, PG);
    const viemDomain = { name: "ChaconneVerifyPlanGuard", version: "1", chainId: FIXTURE_CHAIN_ID, verifyingContract: PG } as const;
    const mandate: TradeMandate = { owner: OWNER.address, recipient: OWNER.address, inputToken: FIXTURE_STABLE, outputSetHash: outputSetHash([FIXTURE_STOCK]), budgetCap: "100000000", perStepCap: "50000000", maxSteps: "2", policyDefinitionHash: report.policyDefinitionHash, effectivePolicyHash: report.effectivePolicyHash, registryHash: report.registryHash, validFrom: "1789900000", deadline: "1790000000", nonce: "1" };
    const md = mandateDigest(domain, mandate);
    const step: MandateStep = { mandateDigest: md, stepIndex: "0", outputToken: FIXTURE_STOCK, amountIn: "50000000", minAmountOut: "1", router: "0x5555555555555555555555555555555555555555", spender: "0x6666666666666666666666666666666666666666", calldataHash: H("77"), evidenceHash: report.evidenceHash, deadline: "1789909931" };
    const sd = stepDigest(domain, step);
    const cert: StepCertificate = { stepDigest: sd, evidenceHash: report.evidenceHash, policyDefinitionHash: report.policyDefinitionHash, effectivePolicyHash: report.effectivePolicyHash, issuedAt: "1789909871", validUntil: "1789909931", signerEpoch: "1" };
    const mSig = await OWNER.signTypedData({ domain: viemDomain, types: EIP712_TYPES_V2, primaryType: "TradeMandate", message: { ...mandate, budgetCap: 100000000n, perStepCap: 50000000n, maxSteps: 2, validFrom: 1789900000n, deadline: 1790000000n, nonce: 1n } });
    const cSig = await SIGNER.signTypedData({ domain: viemDomain, types: EIP712_TYPES_V2, primaryType: "StepCertificate", message: { ...cert, issuedAt: 1789909871n, validUntil: 1789909931n, signerEpoch: 1n } });
    const body: Omit<EvidenceBundle, "bundleHash" | "bundleSignature"> = {
      schemaVersion: "1", kind: "mandate", id: "mnd_1", exportedAt: T_REGULAR, chainId: FIXTURE_CHAIN_ID, job: v.job, registryVersion: registry.version, registry: registry.entries, registryHash: report.registryHash, policy: v.policy.definition, effectivePolicy: v.policy, evidence, reports: [report],
      certificates: [{ typedData: { domain: viemDomain, types: { StepCertificate: [...EIP712_TYPES_V2.StepCertificate] }, primaryType: "StepCertificate", message: cert }, signature: cSig, signer: SIGNER.address, epoch: 1 }],
      mandate: { typedData: { domain: viemDomain, types: { TradeMandate: [...EIP712_TYPES_V2.TradeMandate] }, primaryType: "TradeMandate", message: mandate }, signature: mSig, steps: [{ stepIndex: "0", state: "CONFIRMED", step, stepDigest: sd, certificate: cert, certificateSignature: cSig, txHash: null, receiptSummary: null }] },
      executions: [], bill: { serviceFees: [], principal: [], gas: [], selfPayment: true },
    };
    const h = bundleHash(body);
    const b: EvidenceBundle = { ...body, bundleHash: h, bundleSignature: await SIGNER.signMessage({ message: { raw: h } }) };
    const ok = await verifyBundleOffline(b, opts);
    expect(failing(ok)).toEqual([]);
    expect(ok.map((c) => c.id)).toEqual(expect.arrayContaining(["mandate_digest", "mandate_step_0_digest", "mandate_step_0_cert_signature", "mandate_signature", "cert_0_step_digest", "cert_0_signature"]));
    const x = JSON.parse(JSON.stringify(b)) as EvidenceBundle;
    x.mandate!.steps[0]!.step.amountIn = "99999999";
    const bad = failing(await verifyBundleOffline(x, opts));
    expect(bad).toEqual(expect.arrayContaining(["bundle_hash", "mandate_step_0_digest", "cert_0_step_digest"]));
    expect(bad).not.toContain("mandate_signature");
    const y = JSON.parse(JSON.stringify(b)) as EvidenceBundle;
    (y.mandate!.typedData as { message: TradeMandate }).message.budgetCap = "1";
    expect(failing(await verifyBundleOffline(y, opts))).toEqual(expect.arrayContaining(["mandate_digest", "mandate_signature"]));
  });

  it("规划报告进包：planHash 重算 + 引用证据齐全；篡改候选 → plan hash 失败", async () => {
    const b = await jobBundle();
    resetFixtureIds();
    const registry = fixtureRegistry();
    const goal = { ownerAddress: FIXTURE_OWNER, recipientAddress: FIXTURE_RECIPIENT, executionChainId: FIXTURE_CHAIN_ID, legs: [{ outputAssetKey: FIXTURE_STOCK_KEY, weightBps: 10_000 }], budget: { inputAssetKeys: [FIXTURE_STABLE_KEY], amountInRaw: "100000000" }, side: "buy" as const, policyId: "STRICT_LIVE" as const, policyVersion: "1.0.0", maxSlippageBps: 50, maxPriceImpactBps: 100, maxReferenceDeviationBps: 300, deadline: "2026-09-25T00:00:00.000Z", ladderBps: [10_000] };
    const specs = buildLadder(goal, registry);
    // 共享证据直接复用包内已有记录（同 evidenceId 不重复入包）
    const shared = b.evidence.filter((e) => e.payload.kind !== "okx_quote");
    const q = quoteEvidence({ receivedAt: new Date(Date.parse(T_REGULAR) - 5000).toISOString(), id: "ev_q_plan" });
    const plan = buildPlanReport({ planId: "plan_b", goal, registry, specs, evidence: { shared, quotes: { [specs[0]!.candidateId]: q } }, evaluatedAt: T_REGULAR });
    const body = { ...b, plans: [plan], evidence: [...b.evidence, q] } as EvidenceBundle;
    const h = bundleHash(body);
    const withPlan: EvidenceBundle = { ...body, bundleHash: h, bundleSignature: await SIGNER.signMessage({ message: { raw: h } }) };
    const checks = await verifyBundleOffline(withPlan, opts);
    expect(failing(checks)).toEqual([]);
    expect(checks.map((c) => c.id)).toEqual(expect.arrayContaining(["plan_plan_b_hash", "plan_plan_b_evidence_present"]));
    const x = JSON.parse(JSON.stringify(withPlan)) as EvidenceBundle;
    x.plans![0]!.candidates[0]!.completionBps = 1;
    expect(failing(await verifyBundleOffline(x, opts))).toEqual(expect.arrayContaining(["bundle_hash", "plan_plan_b_hash"]));
  });
});

describe("V-07：签名者来源与未校验语义", () => {
  it("包内 attestationSigner 优先于证书 signer；没有任何 signer 时 bundle_signature 记 skipped（不是失败）", async () => {
    const base = await jobBundle();
    const noCerts = { ...base, certificates: [] } as EvidenceBundle & { attestationSigner?: `0x${string}` };
    delete noCerts.attestationSigner;
    const r1 = await verifyBundleOffline(noCerts, opts);
    const sig1 = r1.find((c) => c.id === "bundle_signature");
    expect(sig1?.skipped).toBe(true);
    expect(sig1?.ok).toBe(true);
    expect(sig1?.detail).toMatch(/not verified/);
    // 包内 attestationSigner 指定后按它验签（这里故意给一个错的地址 → 不通过，证明它被采用了）
    const wrong = { ...noCerts, attestationSigner: "0x1111111111111111111111111111111111111111" as const };
    const r2 = await verifyBundleOffline(wrong, opts);
    const sig2 = r2.find((c) => c.id === "bundle_signature");
    expect(sig2?.skipped).toBeUndefined();
    expect(sig2?.ok).toBe(false);
    expect(sig2?.detail).toMatch(/0x1111/);
    // 正确的 signer → 通过
    const right = { ...noCerts, attestationSigner: SIGNER.address.toLowerCase() as `0x${string}` };
    expect((await verifyBundleOffline(right, opts)).find((c) => c.id === "bundle_signature")?.ok).toBe(true);
  });
});
