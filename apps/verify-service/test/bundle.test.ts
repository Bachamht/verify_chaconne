/** 证据包（V-01 / V-02 / V-03 / V-04 / V-06）：组装 → core 离线验证器逐项通过；篡改任一字段 → 指出失败层 */
import { afterEach, describe, expect, it } from "vitest";
import { verifyMessage, verifyTypedData } from "viem";
import { verifyBundleOffline, type EvidenceBundle } from "@chaconne/core/verify";
import { privateKeyToAccount } from "viem/accounts";
import { api, createTestEnv, jobBody, signedMandateBody, TEST_OWNER_KEY, type TestEnv } from "./helpers";

let env: TestEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const injected = {
  verifyTypedData: (a: { address: `0x${string}`; typedData: { domain: Record<string, unknown>; types: Record<string, Array<{ name: string; type: string }>>; primaryType: string; message: Record<string, unknown> }; signature: `0x${string}` }) =>
    verifyTypedData({ address: a.address, domain: a.typedData.domain, types: a.typedData.types, primaryType: a.typedData.primaryType, message: normalize(a.typedData.message), signature: a.signature } as never),
  verifyMessage: (a: { address: `0x${string}`; raw: `0x${string}`; signature: `0x${string}` }) => verifyMessage({ address: a.address, message: { raw: a.raw }, signature: a.signature }),
};

/** typedData.message 里的 uint 在包里是十进制字符串；viem 需要 bigint/number */
function normalize(m: Record<string, unknown>): Record<string, unknown> {
  const uint256 = new Set(["amountIn", "minAmountOut", "nonce", "budgetCap", "perStepCap"]);
  const uint64 = new Set(["deadline", "issuedAt", "validUntil", "signerEpoch", "validFrom"]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(m)) out[k] = k === "maxSteps" || k === "stepIndex" ? Number(v) : uint256.has(k) || uint64.has(k) ? BigInt(v as string) : v;
  return out;
}

describe("GET /v1/jobs/:id/bundle（W3）", () => {
  it("V-01/V-03/V-04：哈希重算、证书签名、规则重算全部通过；V-06 验证器无需服务在线", async () => {
    env = await createTestEnv();
    const owner = privateKeyToAccount(TEST_OWNER_KEY);
    const jobId = (await api(env, "POST", "/v1/jobs", jobBody({ ownerAddress: owner.address.toLowerCase() as `0x${string}`, recipientAddress: owner.address.toLowerCase() as `0x${string}` }))).json["jobId"] as string;
    const prep = await api(env, "POST", `/v1/jobs/${jobId}/prepare-execution`, { refreshKey: "b1" });
    const exec = prep.json["execution"] as { typedData: { domain: Record<string, unknown>; types: Record<string, Array<{ name: string; type: string }>>; message: Record<string, string> }; intentDigest: string };
    const intentSignature = await owner.signTypedData({ domain: exec.typedData.domain, types: exec.typedData.types, primaryType: "TradeIntent", message: normalize(exec.typedData.message) } as never);
    const sub = await api(env, "POST", `/v1/jobs/${jobId}/submissions`, { attemptId: prep.json["attemptId"], txHash: "0x" + "ab".repeat(32), intentSignature });
    expect(sub.status).toBe(202);
    const r = await api(env, "GET", `/v1/jobs/${jobId}/bundle`);
    expect(r.status).toBe(200);
    const bundle = r.json as unknown as EvidenceBundle;
    expect(bundle.kind).toBe("job");
    expect(bundle.reports.length).toBe(2);
    expect(bundle.certificates.length).toBe(1);
    expect(bundle.intents!.length).toBe(1);
    expect(bundle.bundleSignature).toMatch(/^0x[0-9a-f]{130}$/);
    const checks = await verifyBundleOffline(bundle, { ...injected, expectedSigner: env.signer!.address });
    const failed = checks.filter((c) => !c.ok);
    expect(failed.map((c) => `${c.id}: ${c.detail}`)).toEqual([]);
    expect(checks.find((c) => c.id === "bundle_hash")!.ok).toBe(true);
    expect(checks.find((c) => c.id === "bundle_signature")!.detail).toContain(env.signer!.address);
    expect(checks.some((c) => c.id.endsWith("_rules") && c.ok)).toBe(true);
  });

  it("V-02 篡改：报告 verdict / 证据 / bundleHash 任一被改 → 指出失败层", async () => {
    env = await createTestEnv();
    const jobId = (await api(env, "POST", "/v1/jobs", jobBody())).json["jobId"] as string;
    const bundle = (await api(env, "GET", `/v1/jobs/${jobId}/bundle`)).json as unknown as EvidenceBundle;

    const tamperedVerdict = JSON.parse(JSON.stringify(bundle)) as EvidenceBundle;
    tamperedVerdict.reports[0]!.verdict = tamperedVerdict.reports[0]!.verdict === "eligible" ? "rejected" : "eligible";
    const c1 = await verifyBundleOffline(tamperedVerdict, { ...injected, expectedSigner: env.signer!.address });
    expect(c1.filter((c) => !c.ok).map((c) => c.id)).toContain("bundle_hash");
    expect(c1.find((c) => c.id.endsWith("_rules"))!.ok).toBe(false);

    const tamperedEvidence = JSON.parse(JSON.stringify(bundle)) as EvidenceBundle;
    const q = tamperedEvidence.evidence.find((e) => e.payload.kind === "okx_quote")!;
    if (q.payload.kind === "okx_quote") q.payload.expectedOutRaw = "999999999999999999";
    const c2 = await verifyBundleOffline(tamperedEvidence, { ...injected, expectedSigner: env.signer!.address });
    expect(c2.filter((c) => !c.ok).map((c) => c.id)).toEqual(expect.arrayContaining(["bundle_hash"]));
    expect(c2.some((c) => c.id.includes("evidence_hash") && !c.ok)).toBe(true);

    const tamperedHash = { ...bundle, bundleHash: ("0x" + "00".repeat(32)) as `0x${string}` };
    const c3 = await verifyBundleOffline(tamperedHash, { ...injected, expectedSigner: env.signer!.address });
    expect(c3.find((c) => c.id === "bundle_hash")!.ok).toBe(false);
    expect(c3.find((c) => c.id === "bundle_signature")!.ok).toBe(false);
  });

  it("授权计划证据包：授权签名、步骤摘要与步骤证书全部可验", async () => {
    env = await createTestEnv();
    const { body } = await signedMandateBody(env, { clientRequestId: "bnd1" });
    const reg = await api(env, "POST", "/v1/mandates", body);
    const id = reg.json["mandateId"] as string;
    await api(env, "POST", `/v1/mandates/${id}/prepare-step`, {});
    const r = await api(env, "GET", `/v1/mandates/${id}/bundle`);
    expect(r.status).toBe(200);
    const bundle = r.json as unknown as EvidenceBundle;
    expect(bundle.kind).toBe("mandate");
    expect(bundle.mandate!.steps.length).toBe(1);
    expect(bundle.certificates.length).toBe(1);
    const checks = await verifyBundleOffline(bundle, { ...injected, expectedSigner: env.signer!.address });
    expect(checks.filter((c) => !c.ok).map((c) => `${c.id}: ${c.detail}`)).toEqual([]);
    expect(checks.some((c) => c.id === "mandate_signature" && c.ok)).toBe(true);
    expect(checks.some((c) => c.id === "mandate_step_0_digest" && c.ok)).toBe(true);
    expect(checks.some((c) => c.id === "mandate_step_0_cert_signature" && c.ok)).toBe(true);
  });

  it("未付款的收费任务不给证据包（402）；他人任务 404", async () => {
    env = await createTestEnv({ priceUsd: "0.01" });
    const jobId = (await api(env, "POST", "/v1/jobs", jobBody())).json["jobId"] as string;
    const r = await api(env, "GET", `/v1/jobs/${jobId}/bundle`);
    expect(r.status).toBe(402);
    const other = await api(env, "GET", `/v1/jobs/${jobId}/bundle`, undefined, {}, "vk_test_beta");
    expect(other.status).toBe(404);
  });
});
