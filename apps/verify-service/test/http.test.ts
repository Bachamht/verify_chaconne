/**
 * HTTP 与支付行为（验收 I-01 / I-02 / P-01～P-08 / P-11 / P-12 的隔离 HTTP 部分）。
 * 全部 FIXTURE + mock 支付：证明程序行为，不证明真实集成。
 */
import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { verifyOrders, verifyPaymentAttempts } from "@chaconne/db";
import { intentDigest, makeDomain, type TradeIntent, type VerifyReport } from "@chaconne/core/verify";
import { T_CLOSED, T_REGULAR } from "@chaconne/core/verify/fixtures";
import { verifyTypedData } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { reconcileOnce } from "../src/jobs/reconcile";
import { MockFacilitatorClient } from "../src/payments/facilitator";
import { api, buildPaymentHeader, createTestEnv, jobBody, OTHER_API_KEY, TEST_ATTESTATION_KEY, TEST_GUARD, type TestEnv } from "./helpers";

let env: TestEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

describe("公开接口与鉴权", () => {
  it("/v1/assets、/v1/policies 无需 key；/v1/jobs 缺 key 401、错 key 403（I-01）", async () => {
    env = await createTestEnv();
    const a = await api(env, "GET", "/v1/assets", undefined, {}, "");
    expect(a.status).toBe(200);
    expect(a.json["registryHash"]).toMatch(/^0x[0-9a-f]{64}$/);
    const p = await api(env, "GET", "/v1/policies", undefined, {}, "");
    expect(p.status).toBe(200);
    expect((p.json["policies"] as unknown[]).length).toBe(6); // 三策略 × v1.0.0 + v1.1.0（CV-D06）
    const missing = await fetch(env.url + "/v1/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    // key 必须带（FIX-175；开放模式只在 VERIFY_AUTH_OPEN=true 时）
    expect(missing.status).toBe(401);
    const bad = await api(env, "POST", "/v1/jobs", jobBody(), {}, "vk_wrong");
    expect(bad.status).toBe(403);
  });

  it("通配 key（web*）按 x-verify-caller 地址隔离任务", async () => {
    env = await createTestEnv();
    const WEB_KEY = "vk_web";
    (env.cfg.apiKeys as { key: string; callerId: string }[]).push({ key: WEB_KEY, callerId: "web:*" });
    await env.close();
    env = await createTestEnv({ extraKeys: `${WEB_KEY}:web:*` });
    const A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const missing = await api(env, "POST", "/v1/jobs", jobBody(), {}, WEB_KEY);
    expect(missing.status).toBe(400);
    const created = await api(env, "POST", "/v1/jobs", jobBody(), { "x-verify-caller": A }, WEB_KEY);
    expect(created.status).toBe(201);
    const jobId = created.json["jobId"] as string;
    expect((await api(env, "GET", `/v1/jobs/${jobId}`, undefined, { "x-verify-caller": A }, WEB_KEY)).status).toBe(200);
    expect((await api(env, "GET", `/v1/jobs/${jobId}`, undefined, { "x-verify-caller": B }, WEB_KEY)).status).toBe(404);
  });

  it("响应带 private/no-store（I-02）", async () => {
    env = await createTestEnv();
    const r = await api(env, "POST", "/v1/jobs", jobBody());
    expect(r.headers.get("cache-control")).toBe("private, no-store");
  });
});

describe("创建任务（免费）", () => {
  it("201 → 报告已算好；同键同体 200 同 jobId；同键异体 409（P-02 / P-03）", async () => {
    env = await createTestEnv();
    const r1 = await api(env, "POST", "/v1/jobs", jobBody());
    expect(r1.status).toBe(201);
    const jobId = r1.json["jobId"] as string;
    expect(jobId).toMatch(/^job_[0-9a-f]{24}$/);
    expect((r1.json["order"] as { state: string }).state).toBe("PAID");
    expect((r1.json["latestReport"] as { verdict: string }).verdict).toBe("eligible");
    expect(r1.json["evidenceMode"]).toBe("FIXTURE");

    const r2 = await api(env, "POST", "/v1/jobs", jobBody());
    expect(r2.status).toBe(200);
    expect(r2.json["jobId"]).toBe(jobId);

    const r3 = await api(env, "POST", "/v1/jobs", jobBody({ amountInRaw: "200000000" }));
    expect(r3.status).toBe(409);
    expect(r3.json["error"]).toBe("idempotency_conflict");
  });

  it("并发同键 → 只创建一个任务", async () => {
    env = await createTestEnv();
    const results = await Promise.all(Array.from({ length: 5 }, () => api(env!, "POST", "/v1/jobs", jobBody({ clientRequestId: "concurrent-1" }))));
    const ids = new Set(results.map((r) => r.json["jobId"]));
    expect(ids.size).toBe(1);
    expect(results.filter((r) => r.status === 201).length).toBe(1);
  });

  it("非法请求 400 带字段错误；不支持的资产 400", async () => {
    env = await createTestEnv();
    const bad = await api(env, "POST", "/v1/jobs", { ...jobBody(), amountInRaw: "0" });
    expect(bad.status).toBe(400);
    expect(bad.json["error"]).toBe("invalid_request");
    const unsupported = await api(env, "POST", "/v1/jobs", jobBody({ outputAssetKey: "eip155:196:0x9999999999999999999999999999999999999999" }));
    expect(unsupported.status).toBe(400);
    expect(unsupported.json["error"]).toBe("asset_unsupported");
  });

  it("免费报告直接 200；他人 key 读 → 404（I-01）", async () => {
    env = await createTestEnv();
    const r = await api(env, "POST", "/v1/jobs", jobBody());
    const jobId = r.json["jobId"] as string;
    const rep = await api(env, "GET", `/v1/jobs/${jobId}/report`);
    expect(rep.status).toBe(200);
    const report = rep.json["report"] as VerifyReport;
    expect(report.verdict).toBe("eligible");
    expect(report.evidenceIds.length).toBe(5);
    expect((rep.json["evidence"] as unknown[]).length).toBe(5);
    const other = await api(env, "GET", `/v1/jobs/${jobId}/report`, undefined, {}, OTHER_API_KEY);
    expect(other.status).toBe(404);
    const view = await api(env, "GET", `/v1/jobs/${jobId}`);
    expect((view.json["order"] as { state: string }).state).toBe("DELIVERED");
  });
});

describe("x402 付费交付（mock facilitator）", () => {
  async function createPaidJob(e: TestEnv) {
    const r = await api(e, "POST", "/v1/jobs", jobBody());
    expect(r.status).toBe(201);
    expect((r.json["order"] as { state: string }).state).toBe("REPORT_READY");
    return r.json["jobId"] as string;
  }

  it("未付款 402 + PAYMENT-REQUIRED；付款后 200 + PAYMENT-RESPONSE；重放同凭证不再结算；再读免费（P-01 / P-02 / P-04）", async () => {
    env = await createTestEnv({ priceUsd: "0.01" });
    const jobId = await createPaidJob(env);
    const unpaid = await api(env, "GET", `/v1/jobs/${jobId}/report`);
    expect(unpaid.status).toBe(402);
    const prHeader = unpaid.headers.get("payment-required");
    expect(prHeader).toBeTruthy();
    expect(unpaid.json["error"]).toBe("payment_required");
    expect((await env.orders.byJobId(jobId))!.state).toBe("PAYMENT_REQUIRED");

    const sig = buildPaymentHeader(prHeader!);
    const paid = await api(env, "GET", `/v1/jobs/${jobId}/report`, undefined, { "payment-signature": sig });
    expect(paid.status).toBe(200);
    expect(paid.headers.get("payment-response")).toBeTruthy();
    expect((paid.json["report"] as VerifyReport).jobId).toBe(jobId);
    expect(env.control.verifyCalls).toBe(1);
    expect(env.control.settleCalls).toBe(1);
    const order = (await env.orders.byJobId(jobId))!;
    expect(order.state).toBe("DELIVERED");
    expect(order.settledAt).not.toBeNull();

    // 同凭证重放：不再次结算
    const replay = await api(env, "GET", `/v1/jobs/${jobId}/report`, undefined, { "payment-signature": sig });
    expect(replay.status).toBe(200);
    expect(env.control.settleCalls).toBe(1);
    // 无凭证再读：已付款直接交付，不再要求付款
    const again = await api(env, "GET", `/v1/jobs/${jobId}/report`);
    expect(again.status).toBe(200);
    expect(env.control.verifyCalls).toBe(1);
    const attempts = await env.db.select().from(verifyPaymentAttempts);
    expect(attempts.length).toBe(1);
    expect(attempts[0]!.state).toBe("SETTLED");
  });

  it("把任务 A 的付款凭证重放到任务 B → 402 资源不匹配，不交付 B（P-04）", async () => {
    env = await createTestEnv({ priceUsd: "0.01" });
    const a = await createPaidJob(env);
    const rb = await api(env, "POST", "/v1/jobs", jobBody({ clientRequestId: "job-b" }));
    const b = rb.json["jobId"] as string;
    const prA = (await api(env, "GET", `/v1/jobs/${a}/report`)).headers.get("payment-required")!;
    const sigA = buildPaymentHeader(prA);
    const res = await api(env, "GET", `/v1/jobs/${b}/report`, undefined, { "payment-signature": sigA });
    expect(res.status).toBe(402);
    expect(res.json["error"]).toBe("payment_resource_mismatch");
    expect(env.control.settleCalls).toBe(0);
    expect((await env.orders.byJobId(b))!.state).not.toBe("PAID");
  });

  it("结算 pending：先交付（信任 facilitator），对账后转 PAID/DELIVERED（P-08）", async () => {
    env = await createTestEnv({ priceUsd: "0.01" });
    env.control.settleBehavior = "pending";
    const jobId = await createPaidJob(env);
    const pr = (await api(env, "GET", `/v1/jobs/${jobId}/report`)).headers.get("payment-required")!;
    const paid = await api(env, "GET", `/v1/jobs/${jobId}/report`, undefined, { "payment-signature": buildPaymentHeader(pr) });
    expect(paid.status).toBe(200);
    expect((await env.orders.byJobId(jobId))!.state).toBe("SETTLEMENT_PENDING");
    const r = await reconcileOnce(env.orders, new MockFacilitatorClient("eip155:1952", env.control));
    expect(r).toEqual({ checked: 1, resolved: 1 });
    expect((await env.orders.byJobId(jobId))!.state).toBe("DELIVERED");
    expect(env.control.statusCalls).toBe(1);
  });

  it("结算调用异常 → 202 PAYMENT_UNKNOWN，不交付、不引导重付；无 tx 的对账保持待核实（P-05）", async () => {
    env = await createTestEnv({ priceUsd: "0.01" });
    env.control.settleBehavior = "throw";
    const jobId = await createPaidJob(env);
    const pr = (await api(env, "GET", `/v1/jobs/${jobId}/report`)).headers.get("payment-required")!;
    const r = await api(env, "GET", `/v1/jobs/${jobId}/report`, undefined, { "payment-signature": buildPaymentHeader(pr) });
    expect(r.status).toBe(202);
    expect(r.json["error"]).toBe("payment_unknown");
    expect((await env.orders.byJobId(jobId))!.state).toBe("PAYMENT_UNKNOWN");
    // 刷新后再来：仍 202，不发 402（不引导重付）
    const again = await api(env, "GET", `/v1/jobs/${jobId}/report`);
    expect(again.status).toBe(202);
    expect(env.control.settleCalls).toBe(1);
    const rec = await reconcileOnce(env.orders, new MockFacilitatorClient("eip155:1952", env.control));
    expect(rec).toEqual({ checked: 1, resolved: 0 });
  });

  it("结算 timeout（有 tx）→ PAYMENT_UNKNOWN；对账 success → PAID → 再读交付（P-05 / P-08）", async () => {
    env = await createTestEnv({ priceUsd: "0.01" });
    env.control.settleBehavior = "timeout";
    env.control.statusBehavior = "pending"; // 轮询窗口内链上仍未确认
    const jobId = await createPaidJob(env);
    const pr = (await api(env, "GET", `/v1/jobs/${jobId}/report`)).headers.get("payment-required")!;
    const r = await api(env, "GET", `/v1/jobs/${jobId}/report`, undefined, { "payment-signature": buildPaymentHeader(pr) });
    expect(r.status).toBe(202);
    expect((await env.orders.byJobId(jobId))!.state).toBe("PAYMENT_UNKNOWN");
    env.control.statusBehavior = "success"; // 链上随后确认
    const rec = await reconcileOnce(env.orders, new MockFacilitatorClient("eip155:1952", env.control));
    expect(rec.resolved).toBe(1);
    expect((await env.orders.byJobId(jobId))!.state).toBe("PAID");
    const ok = await api(env, "GET", `/v1/jobs/${jobId}/report`);
    expect(ok.status).toBe(200);
    expect(env.control.settleCalls).toBe(1);
  });

  it("结算失败 → 402 settlement_failed，订单回 PAYMENT_REQUIRED，新凭证可再付（P-08）", async () => {
    env = await createTestEnv({ priceUsd: "0.01" });
    env.control.settleBehavior = "failed";
    const jobId = await createPaidJob(env);
    const pr = (await api(env, "GET", `/v1/jobs/${jobId}/report`)).headers.get("payment-required")!;
    const r = await api(env, "GET", `/v1/jobs/${jobId}/report`, undefined, { "payment-signature": buildPaymentHeader(pr, undefined, "1") });
    expect(r.status).toBe(402);
    expect(r.json["error"]).toBe("settlement_failed");
    expect((await env.orders.byJobId(jobId))!.state).toBe("PAYMENT_REQUIRED");
    env.control.settleBehavior = "success";
    const r2 = await api(env, "GET", `/v1/jobs/${jobId}/report`, undefined, { "payment-signature": buildPaymentHeader(pr, undefined, "2") });
    expect(r2.status).toBe(200);
    const attempts = await env.db.select().from(verifyPaymentAttempts);
    expect(attempts.map((a) => a.state).sort()).toEqual(["FAILED", "SETTLED"]);
  });

  it("验证不通过（伪造/不匹配凭证）→ 402，不登记尝试", async () => {
    env = await createTestEnv({ priceUsd: "0.01" });
    env.control.verifyValid = false;
    const jobId = await createPaidJob(env);
    const pr = (await api(env, "GET", `/v1/jobs/${jobId}/report`)).headers.get("payment-required")!;
    const r = await api(env, "GET", `/v1/jobs/${jobId}/report`, undefined, { "payment-signature": buildPaymentHeader(pr) });
    expect(r.status).toBe(402);
    expect((await env.db.select().from(verifyPaymentAttempts)).length).toBe(0);
    expect(env.control.settleCalls).toBe(0);
  });

  it("未付款不能准备执行（402）", async () => {
    env = await createTestEnv({ priceUsd: "0.01" });
    const jobId = await createPaidJob(env);
    const r = await api(env, "POST", `/v1/jobs/${jobId}/prepare-execution`, { refreshKey: "k1" });
    expect(r.status).toBe(402);
    expect(r.json["error"]).toBe("payment_required");
  });
});

describe("准备执行：额度、nonce、证书（P-11 / P-12 / V3-04）", () => {
  it("两次刷新各出新版本；同键重放不耗额；第三次 409；证书签名与摘要绑定可验", async () => {
    env = await createTestEnv();
    const jobId = (await api(env, "POST", "/v1/jobs", jobBody())).json["jobId"] as string;
    const r1 = await api(env, "POST", `/v1/jobs/${jobId}/prepare-execution`, { refreshKey: "k1" });
    expect(r1.status).toBe(200);
    expect(r1.json["state"]).toBe("PREPARED");
    expect(r1.json["reportVersion"]).toBe(2);
    expect(r1.json["refreshesRemaining"]).toBe(1);
    const exec = r1.json["execution"] as {
      typedData: { domain: Parameters<typeof intentDigest>[0]; message: TradeIntent };
      intentDigest: string;
      certificate: { intentDigest: string; issuedAt: string; validUntil: string; signerEpoch: string; evidenceHash: string; policyDefinitionHash: string; effectivePolicyHash: string };
      certificateSignature: `0x${string}`;
      attestationSigner: string;
      approval: { token: string; spender: string; amount: string };
      guardCall: { to: string };
    };
    // 摘要绑定：intentDigest = EIP-712(domain(196, guard), intent)
    expect(exec.typedData.domain.verifyingContract).toBe(TEST_GUARD);
    expect(exec.intentDigest).toBe(intentDigest(makeDomain(196, TEST_GUARD), exec.typedData.message));
    expect(exec.certificate.intentDigest).toBe(exec.intentDigest);
    expect(exec.approval.spender).toBe(TEST_GUARD);
    expect(exec.approval.amount).toBe(exec.typedData.message.amountIn);
    expect(Number(exec.certificate.validUntil) - Number(exec.certificate.issuedAt)).toBe(28); // FIX-088：受报价时效约束（fixture 报价 2 s 前收到，quoteMaxAge 30）
    expect(exec.typedData.message.deadline).toBe(exec.certificate.validUntil);
    // 证书签名可由 signer 地址验证
    const signerAddr = privateKeyToAccount(TEST_ATTESTATION_KEY).address;
    expect(exec.attestationSigner).toBe(signerAddr.toLowerCase());
    const { EIP712_TYPES } = await import("@chaconne/core/verify");
    const valid = await verifyTypedData({
      address: signerAddr,
      domain: { name: "ChaconneVerifyGuard", version: "1", chainId: 196, verifyingContract: TEST_GUARD },
      types: EIP712_TYPES,
      primaryType: "VerificationCertificate",
      message: {
        intentDigest: exec.certificate.intentDigest as `0x${string}`,
        evidenceHash: exec.certificate.evidenceHash as `0x${string}`,
        policyDefinitionHash: exec.certificate.policyDefinitionHash as `0x${string}`,
        effectivePolicyHash: exec.certificate.effectivePolicyHash as `0x${string}`,
        issuedAt: BigInt(exec.certificate.issuedAt),
        validUntil: BigInt(exec.certificate.validUntil),
        signerEpoch: BigInt(exec.certificate.signerEpoch),
      },
      signature: exec.certificateSignature,
    });
    expect(valid).toBe(true);

    const replay = await api(env, "POST", `/v1/jobs/${jobId}/prepare-execution`, { refreshKey: "k1" });
    expect(replay.status).toBe(200);
    expect(replay.json["replay"]).toBe(true);
    expect(replay.json["attemptId"]).toBe(r1.json["attemptId"]);
    expect(replay.json["refreshesRemaining"]).toBe(1);

    const r2 = await api(env, "POST", `/v1/jobs/${jobId}/prepare-execution`, { refreshKey: "k2" });
    expect(r2.status).toBe(200);
    expect(r2.json["reportVersion"]).toBe(3);
    expect(r2.json["refreshesRemaining"]).toBe(0);
    // 同任务共用一个 nonce
    const nonce1 = exec.typedData.message.nonce;
    const nonce2 = (r2.json["execution"] as { typedData: { message: TradeIntent } }).typedData.message.nonce;
    expect(nonce2).toBe(nonce1);

    const r3 = await api(env, "POST", `/v1/jobs/${jobId}/prepare-execution`, { refreshKey: "k3" });
    expect(r3.status).toBe(409);
    expect(r3.json["error"]).toBe("entitlement_exhausted");

    const view = await api(env, "GET", `/v1/jobs/${jobId}`);
    expect((view.json["executions"] as unknown[]).length).toBe(2);
    expect((view.json["entitlement"] as { usedRefreshes: number }).usedRefreshes).toBe(2);
  });

  it("并发三次不同键 → 恰好两次成功（额度原子）", async () => {
    env = await createTestEnv();
    const jobId = (await api(env, "POST", "/v1/jobs", jobBody())).json["jobId"] as string;
    const rs = await Promise.all(["a", "b", "c"].map((k) => api(env!, "POST", `/v1/jobs/${jobId}/prepare-execution`, { refreshKey: k })));
    expect(rs.filter((r) => r.status === 200).length).toBe(2);
    expect(rs.filter((r) => r.status === 409).length).toBe(1);
  });

  it("窗口过期后 409；改意图 = 新任务（P-12）", async () => {
    env = await createTestEnv();
    const jobId = (await api(env, "POST", "/v1/jobs", jobBody())).json["jobId"] as string;
    env.setNow(new Date(Date.parse(T_REGULAR) + 301_000).toISOString());
    const r = await api(env, "POST", `/v1/jobs/${jobId}/prepare-execution`, { refreshKey: "late" });
    expect(r.status).toBe(409);
    // 改金额必须新建任务（幂等键相同 → 409 冲突；新键 → 新任务新额度）
    const conflict = await api(env, "POST", "/v1/jobs", jobBody({ amountInRaw: "50000000" }));
    expect(conflict.status).toBe(409);
    const fresh = await api(env, "POST", "/v1/jobs", jobBody({ amountInRaw: "50000000", clientRequestId: "new-intent" }));
    expect(fresh.status).toBe(201);
    expect(fresh.json["jobId"]).not.toBe(jobId);
  });

  it("再核验不合格（无报价）→ 422 REJECTED，仍消耗额度，不签证书", async () => {
    env = await createTestEnv({ scenario: "no_quote" });
    const created = await api(env, "POST", "/v1/jobs", jobBody());
    expect((created.json["latestReport"] as { verdict: string }).verdict).toBe("rejected");
    const jobId = created.json["jobId"] as string;
    const r = await api(env, "POST", `/v1/jobs/${jobId}/prepare-execution`, { refreshKey: "k1" });
    expect(r.status).toBe(422);
    expect(r.json["state"]).toBe("REJECTED");
    expect(r.json["execution"]).toBeNull();
    expect(r.json["refreshesRemaining"]).toBe(1);
  });

  it("休市 + REFERENCE_CONTEXT：交叉核验收盘 → 可准备执行；STRICT_LIVE 同时刻 → 拒绝", async () => {
    env = await createTestEnv({ scenario: "closed", now: T_CLOSED });
    const rc = await api(env, "POST", "/v1/jobs", jobBody({ policyId: "REFERENCE_CONTEXT", clientRequestId: "rc" }));
    expect((rc.json["latestReport"] as { verdict: string }).verdict).toBe("eligible");
    const sl = await api(env, "POST", "/v1/jobs", jobBody({ policyId: "STRICT_LIVE", clientRequestId: "sl" }));
    expect((sl.json["latestReport"] as { verdict: string }).verdict).toBe("rejected");
    const prep = await api(env, "POST", `/v1/jobs/${rc.json["jobId"]}/prepare-execution`, { refreshKey: "k" });
    expect(prep.status).toBe(200);
    const report = prep.json["report"] as VerifyReport;
    expect(report.reference?.kind).toBe("close_cross_verified");
  });

  it("无 Guard 地址 → 503；无证明私钥 → 503", async () => {
    env = await createTestEnv({ withGuard: false });
    const jobId = (await api(env, "POST", "/v1/jobs", jobBody())).json["jobId"] as string;
    expect((await api(env, "POST", `/v1/jobs/${jobId}/prepare-execution`, { refreshKey: "k" })).json["error"]).toBe("guard_not_configured");
    await env.close();
    env = await createTestEnv({ withSigner: false });
    const j2 = (await api(env, "POST", "/v1/jobs", jobBody())).json["jobId"] as string;
    expect((await api(env, "POST", `/v1/jobs/${j2}/prepare-execution`, { refreshKey: "k" })).json["error"]).toBe("attestation_disabled");
  });
});

describe("提交记录", () => {
  it("202 记录 hash；同尝试换 hash 409；非法 hash 400；成功不等于成交（状态 SUBMITTED）", async () => {
    env = await createTestEnv();
    const jobId = (await api(env, "POST", "/v1/jobs", jobBody())).json["jobId"] as string;
    const prep = await api(env, "POST", `/v1/jobs/${jobId}/prepare-execution`, { refreshKey: "k1" });
    const attemptId = prep.json["attemptId"] as string;
    const tx = `0x${"11".repeat(32)}`;
    const s1 = await api(env, "POST", `/v1/jobs/${jobId}/submissions`, { attemptId, txHash: tx });
    expect(s1.status).toBe(202);
    expect(s1.json["state"]).toBe("SUBMITTED");
    const s2 = await api(env, "POST", `/v1/jobs/${jobId}/submissions`, { attemptId, txHash: `0x${"22".repeat(32)}` });
    expect(s2.status).toBe(409);
    const s3 = await api(env, "POST", `/v1/jobs/${jobId}/submissions`, { attemptId, txHash: "0x12" });
    expect(s3.status).toBe(400);
    const orders = await env.db.select().from(verifyOrders).where(eq(verifyOrders.jobId, jobId));
    expect(orders[0]!.state).toBe("PAID"); // 免费单未读报告：仍 PAID，执行状态与订单状态分离（P-10）
  });
});
