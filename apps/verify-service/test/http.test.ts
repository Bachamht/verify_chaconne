/**
 * HTTP 与支付行为（验收 I-01 / I-02 / P-01～P-08 / P-11 / P-12 的隔离 HTTP 部分）。
 * 全部 FIXTURE + mock 支付：证明程序行为，不证明真实集成。
 */
import { afterEach, describe, expect, it } from "vitest";
import { verifyPaymentAttempts } from "@chaconne/db";
import type { VerifyReport } from "@chaconne/core/verify";
import { reconcileOnce } from "../src/jobs/reconcile";
import { MockFacilitatorClient } from "../src/payments/facilitator";
import { api, buildPaymentHeader, createTestEnv, jobBody, OTHER_API_KEY, type TestEnv } from "./helpers";

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

});

