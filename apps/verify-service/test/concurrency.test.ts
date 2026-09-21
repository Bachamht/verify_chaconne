/**
 * FIX-087（P-13）：同一订单并发付款——同凭证 10 并发 / 不同凭证 3 并发 → 只结算一次；交付前结算已落库。
 * FIX-088（G-13）：证书 validUntil 受报价/参考时效约束。
 */
import { afterEach, describe, expect, it } from "vitest";
import { verifyOrders, verifyPaymentAttempts } from "@chaconne/db";
import { eq } from "drizzle-orm";
import { T_REGULAR } from "@chaconne/core/verify/fixtures";
import { api, buildPaymentHeader, createTestEnv, jobBody, type TestEnv } from "./helpers";
import { certificateValidUntil } from "../src/jobs/service";
import { POLICY_QUOTE_ONLY_V1, POLICY_STRICT_LIVE_V1 } from "@chaconne/core/verify";

let env: TestEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

describe("P-13 支付并发（FIX-087）", () => {
  it("同一凭证 10 并发：恰好 1 次 settle，全部 200，一条 SETTLED 尝试，订单 DELIVERED 且 settledAt ≤ deliveredAt", async () => {
    env = await createTestEnv({ priceUsd: "0.01" });
    const jobId = (await api(env, "POST", "/v1/jobs", jobBody())).json["jobId"] as string;
    const pr = (await api(env, "GET", `/v1/jobs/${jobId}/report`)).headers.get("payment-required")!;
    const sig = buildPaymentHeader(pr);
    const results = await Promise.all(Array.from({ length: 10 }, () => api(env!, "GET", `/v1/jobs/${jobId}/report`, undefined, { "payment-signature": sig })));
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(200));
    expect(env.control.settleCalls).toBe(1);
    const attempts = await env.db.select().from(verifyPaymentAttempts);
    expect(attempts.length).toBe(1);
    expect(attempts[0]!.state).toBe("SETTLED");
    const order = (await env.db.select().from(verifyOrders).where(eq(verifyOrders.jobId, jobId)))[0]!;
    expect(order.state).toBe("DELIVERED");
    expect(order.settledAt!.getTime()).toBeLessThanOrEqual(order.deliveredAt!.getTime());
  });

  it("同一订单 3 个不同凭证并发：只结算 1 次；锁后到达的凭证看到订单已放行直接交付，不登记不扣款，全部 200", async () => {
    env = await createTestEnv({ priceUsd: "0.01" });
    const jobId = (await api(env, "POST", "/v1/jobs", jobBody())).json["jobId"] as string;
    const pr = (await api(env, "GET", `/v1/jobs/${jobId}/report`)).headers.get("payment-required")!;
    const sigs = ["1", "2", "3"].map((n) => buildPaymentHeader(pr, undefined, n));
    const results = await Promise.all(sigs.map((sig) => api(env!, "GET", `/v1/jobs/${jobId}/report`, undefined, { "payment-signature": sig })));
    expect(results.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(env.control.settleCalls).toBe(1);
    const attempts = await env.db.select().from(verifyPaymentAttempts);
    expect(attempts.map((a) => a.state)).toEqual(["SETTLED"]);
  });

  it("结算异常时并发同凭证：全部 202 payment_unknown，不重付", async () => {
    env = await createTestEnv({ priceUsd: "0.01" });
    env.control.settleBehavior = "throw";
    const jobId = (await api(env, "POST", "/v1/jobs", jobBody())).json["jobId"] as string;
    const pr = (await api(env, "GET", `/v1/jobs/${jobId}/report`)).headers.get("payment-required")!;
    const sig = buildPaymentHeader(pr);
    const results = await Promise.all(Array.from({ length: 5 }, () => api(env!, "GET", `/v1/jobs/${jobId}/report`, undefined, { "payment-signature": sig })));
    expect(results.map((r) => r.status)).toEqual(Array(5).fill(202));
    expect(env.control.settleCalls).toBe(1);
    expect(env.paywall.locks.size).toBe(0);
  });
});

describe("G-13 证书有效期受数据时效约束（FIX-088）", () => {
  it("纯函数：quote 25 s 前收到 → validUntil = issuedAt + 5；STRICT_LIVE 参考 85 s 前发布 → +5；否则 +60", () => {
    const issuedAt = 1_800_000_000;
    const iso = (sec: number) => new Date(sec * 1000).toISOString();
    const quoteOld = { normalizedQuote: { receivedAt: iso(issuedAt - 25) } as never, reference: null };
    expect(certificateValidUntil(issuedAt, POLICY_QUOTE_ONLY_V1, quoteOld)).toBe(issuedAt + 5);
    const fresh = { normalizedQuote: { receivedAt: iso(issuedAt - 1) } as never, reference: { sourcePublishedAt: iso(issuedAt - 1) } as never };
    expect(certificateValidUntil(issuedAt, POLICY_STRICT_LIVE_V1, fresh)).toBe(issuedAt + 29);
    const refOld = { normalizedQuote: { receivedAt: iso(issuedAt) } as never, reference: { sourcePublishedAt: iso(issuedAt - 85) } as never };
    expect(certificateValidUntil(issuedAt, POLICY_STRICT_LIVE_V1, refOld)).toBe(issuedAt + 5);
    // REFERENCE_CONTEXT 不受参考时效约束（收盘价），只受报价约束
    expect(certificateValidUntil(issuedAt, POLICY_QUOTE_ONLY_V1, refOld)).toBe(issuedAt + 30);
    // 已过期数据：兜底 issuedAt+1
    expect(certificateValidUntil(issuedAt, POLICY_QUOTE_ONLY_V1, { normalizedQuote: { receivedAt: iso(issuedAt - 100) } as never, reference: null })).toBe(issuedAt + 1);
  });

  it("HTTP：报价 25 s 前收到 → 证书 validUntil = issuedAt + 5（而非 +60）", async () => {
    env = await createTestEnv({
      evidenceDecorator: (c, nowIso) => {
        for (const e of c.evidence)
          if (e.payload.kind === "okx_quote") {
            e.time.receivedAt = new Date(Date.parse(nowIso) - 25_000).toISOString();
            e.time.requestedAt = new Date(Date.parse(nowIso) - 25_200).toISOString();
          }
        return c;
      },
    });
    const jobId = (await api(env, "POST", "/v1/jobs", jobBody())).json["jobId"] as string;
    const prep = await api(env, "POST", `/v1/jobs/${jobId}/prepare-execution`, { refreshKey: "ttl" });
    expect(prep.status).toBe(200);
    const exec = prep.json["execution"] as { validUntil: string; certificate: { issuedAt: string; validUntil: string } };
    expect(Number(exec.certificate.validUntil) - Number(exec.certificate.issuedAt)).toBe(5);
    expect(Date.parse(exec.validUntil)).toBe(Date.parse(T_REGULAR) + 5000);
  });
});
