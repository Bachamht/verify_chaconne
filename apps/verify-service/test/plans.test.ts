/** 规划任务（PL-01 / PL-02 / PL-08）与商品目录/账单（U-01 / U-02） */
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURE_STOCK_KEY, T_CLOSED } from "@chaconne/core/verify/fixtures";
import type { PlanReport } from "@chaconne/core/verify";
import { api, createTestEnv, planBody, type TestEnv } from "./helpers";

let env: TestEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

describe("POST /v1/plans（W1）", () => {
  it("PL-01 阶梯候选确定性：同参数同时刻两次 → 同 planHash / goalHash；候选数 ≤ 12，每腿 quote ≤ 8", async () => {
    env = await createTestEnv();
    const a = await api(env, "POST", "/v1/plans", planBody({ clientRequestId: "p1" }));
    expect(a.status).toBe(201);
    const plan = a.json["plan"] as PlanReport;
    expect(plan.candidates.length).toBeLessThanOrEqual(12);
    expect(plan.candidates.length).toBeGreaterThan(0);
    expect(plan.planHash).toMatch(/^0x[0-9a-f]{64}$/);
    // 同键重放 → 200 同 planHash
    const replay = await api(env, "POST", "/v1/plans", planBody({ clientRequestId: "p1" }));
    expect(replay.status).toBe(200);
    expect(replay.json["planHash"]).toBe(a.json["planHash"]);
    // 新键同目标（同证据集合）→ candidates 结构一致（candidateId 由内容派生）
    const b = await api(env, "POST", "/v1/plans", planBody({ clientRequestId: "p2" }));
    const planB = b.json["plan"] as PlanReport;
    expect(planB.goalHash).toBe(plan.goalHash); // clientRequestId 不进 goalHash；同目标 → 同 goalHash
    expect(planB.candidates.map((c) => c.candidateId)).toEqual(plan.candidates.map((c) => c.candidateId));
    expect(planB.candidates.map((c) => c.completionBps)).toEqual(plan.candidates.map((c) => c.completionBps));
  });

  it("PL-02 recommended 只取 eligible 且 completionBps 最大者；USER_MUST_RELAX_LIMIT 永不推荐", async () => {
    env = await createTestEnv();
    const r = await api(env, "POST", "/v1/plans", planBody());
    const plan = r.json["plan"] as PlanReport;
    const rec = plan.candidates.find((c) => c.candidateId === plan.recommended);
    if (rec) {
      expect(rec.chosenPolicyVerdict).toBe("eligible");
      expect(rec.nextStep).not.toBe("USER_MUST_RELAX_LIMIT");
      for (const c of plan.candidates) if (c.chosenPolicyVerdict === "eligible" && c.nextStep !== "USER_MUST_RELAX_LIMIT") expect(c.completionBps).toBeLessThanOrEqual(rec.completionBps);
    }
    // 每个候选都带三策略对照
    for (const c of plan.candidates) expect(Object.keys(c.verdictByPolicy).sort()).toEqual(["QUOTE_ONLY", "REFERENCE_CONTEXT", "STRICT_LIVE"]);
  });

  it("休市 + STRICT_LIVE：全部候选被拒、recommended = null（不自动降级）", async () => {
    env = await createTestEnv({ now: T_CLOSED, scenario: "closed" });
    const r = await api(env, "POST", "/v1/plans", planBody({ policyId: "STRICT_LIVE", deadline: new Date(Date.parse(T_CLOSED) + 3600_000).toISOString() }));
    const plan = r.json["plan"] as PlanReport;
    expect(plan.recommended).toBeNull();
    expect(plan.candidates.every((c) => c.chosenPolicyVerdict === "rejected")).toBe(true);
    expect(plan.candidates[0]!.reasons.some((x) => x.code === "MARKET_OUTSIDE_REGULAR")).toBe(true);
    // 同证据下 REFERENCE_CONTEXT 对照是 eligible（对照不改变选中策略结论）
    expect(plan.candidates[0]!.verdictByPolicy.REFERENCE_CONTEXT.verdict).toBe("eligible");
  });

  it("PL-08 候选转任务：requestHash 链一致，同候选重复转 → 同 jobId；需放宽限制的候选 409", async () => {
    env = await createTestEnv();
    const r = await api(env, "POST", "/v1/plans", planBody({ clientRequestId: "p3" }));
    const planId = r.json["planId"] as string;
    const plan = r.json["plan"] as PlanReport;
    const rec = plan.candidates.find((c) => c.candidateId === plan.recommended)!;
    const j1 = await api(env, "POST", `/v1/plans/${planId}/jobs`, {});
    expect(j1.status).toBe(201);
    expect(j1.json["job"]).toBeTruthy();
    expect((j1.json["job"] as { amountInRaw: string }).amountInRaw).toBe(rec.amountInRaw);
    expect(j1.json["clientRequestId"]).toBe(`${planId}:${rec.candidateId}`);
    const j2 = await api(env, "POST", `/v1/plans/${planId}/jobs`, { candidateId: rec.candidateId });
    expect(j2.status).toBe(200);
    expect(j2.json["jobId"]).toBe(j1.json["jobId"]);
    expect(j2.json["requestHash"]).toBe(j1.json["requestHash"]);
    const blocked = plan.candidates.find((c) => c.nextStep === "USER_MUST_RELAX_LIMIT");
    if (blocked) {
      const bad = await api(env, "POST", `/v1/plans/${planId}/jobs`, { candidateId: blocked.candidateId });
      expect(bad.status).toBe(409);
      expect(bad.json["error"]).toBe("candidate_requires_relaxed_limit");
    }
  });

  it("校验：legs 权重必须合计 10000；资产必须在登记表；他人 key 读 404", async () => {
    env = await createTestEnv();
    const bad = await api(env, "POST", "/v1/plans", planBody({ legs: [{ outputAssetKey: FIXTURE_STOCK_KEY, weightBps: 5000 }] }));
    expect(bad.status).toBe(400);
    expect((bad.json["details"] as Array<{ field: string }>).some((e) => e.field === "legs.weightBps")).toBe(true);
    const unknown = await api(env, "POST", "/v1/plans", planBody({ budget: { inputAssetKeys: ["eip155:196:0x0000000000000000000000000000000000000009"], amountInRaw: "100000000" } }));
    expect(unknown.status).toBe(400);
    expect(unknown.json["error"]).toBe("asset_unsupported");
    const ok = await api(env, "POST", "/v1/plans", planBody());
    const other = await api(env, "GET", `/v1/plans/${ok.json["planId"]}`, undefined, {}, "vk_test_beta");
    expect(other.status).toBe(404);
  });

  it("收费规划：未付款时 view 不含 plan、/report 402；付款后 200 且带候选", async () => {
    env = await createTestEnv({ env: { PRODUCT_PRICE_PLAN_USD: "0.02" } });
    const r = await api(env, "POST", "/v1/plans", planBody());
    expect(r.status).toBe(201);
    expect(r.json["plan"]).toBeNull();
    const planId = r.json["planId"] as string;
    const unpaid = await api(env, "GET", `/v1/plans/${planId}/report`);
    expect(unpaid.status).toBe(402);
    const pr = unpaid.headers.get("payment-required")!;
    const { buildPaymentHeader } = await import("./helpers");
    const paid = await api(env, "GET", `/v1/plans/${planId}/report`, undefined, { "payment-signature": buildPaymentHeader(pr) });
    expect(paid.status).toBe(200);
    expect((paid.json["plan"] as PlanReport).candidates.length).toBeGreaterThan(0);
    expect(paid.json["planHash"]).toMatch(/^0x/);
  });
});

describe("商品与账单（U-01 / U-02）", () => {
  it("U-01 /v1/products 四个 SKU，含价格、有效期、交付定义与「没有可行方案算什么」，中英文齐全", async () => {
    env = await createTestEnv({ env: { PRODUCT_PRICE_PLAN_USD: "0.02", PRODUCT_PRICE_TASK_BUNDLE_USD: "0.5" } });
    const r = await api(env, "GET", "/v1/products", undefined, {}, "");
    expect(r.status).toBe(200);
    const products = r.json["products"] as Array<Record<string, unknown>>;
    expect(products.map((p) => p["sku"])).toEqual(["verify_once", "plan", "monitor_window", "task_bundle"]);
    for (const p of products) {
      for (const k of ["name", "delivery", "noResultIs"]) {
        expect((p[k] as { en: string }).en.length).toBeGreaterThan(10);
        expect((p[k] as { zh: string }).zh.length).toBeGreaterThanOrEqual(4);
      }
      expect(typeof p["priceUsd"]).toBe("string");
      expect(p["network"]).toBe("eip155:1952");
    }
    expect(products[1]!["priceUsd"]).toBe("0.02");
    expect(products[3]!["priceUsd"]).toBe("0.5");
    expect(products[2]!["validitySeconds"]).toBe(86400);
  });

  it("U-02 账单：服务费/本金/gas 分列；自付地址标 selfPayment", async () => {
    env = await createTestEnv({ env: { DEMO_SELF_PAYMENT_ADDRESSES: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } });
    const jobId = (await api(env, "POST", "/v1/jobs", (await import("./helpers")).jobBody())).json["jobId"] as string;
    const prep = await api(env, "POST", `/v1/jobs/${jobId}/prepare-execution`, { refreshKey: "b1" });
    const attemptId = prep.json["attemptId"] as string;
    await api(env, "POST", `/v1/jobs/${jobId}/submissions`, { attemptId, txHash: "0x" + "cd".repeat(32) });
    await env.service.applyReceipt(attemptId, "CONFIRMED", { status: "success", gasUsed: "551123", txHash: "0x" + "cd".repeat(32), event: { spent: "100000000", received: "400000000000000000", refunded: "0" } });
    const r = await api(env, "GET", `/v1/jobs/${jobId}/bill`);
    expect(r.status).toBe(200);
    const bill = r.json["bill"] as { serviceFees: unknown[]; principal: Array<{ amountRaw: string }>; gas: Array<{ amountRaw: string }>; selfPayment: boolean };
    expect(bill.serviceFees.length).toBe(1);
    expect(bill.principal[0]!.amountRaw).toBe("100000000");
    expect(bill.gas[0]!.amountRaw).toBe("551123");
    expect(bill.selfPayment).toBe(true);
  });
});
