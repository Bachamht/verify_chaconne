/** A2MCP 单端点：空参 → **200** status=input_required(schema)（OKX 客户端只接受 200/402）；免费 → 200 delivered；同参幂等；收费 → 402；宽容输入 */
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURE_STABLE_KEY, FIXTURE_STOCK_KEY } from "@chaconne/core/verify/fixtures";
import { createTestEnv, TEST_API_KEY, type TestEnv } from "./helpers";

let env: TestEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

async function call(e: TestEnv, body: unknown, method = "POST") {
  const res = await fetch(e.url + "/a2mcp/verify", {
    method,
    headers: { "content-type": "application/json" },
    body: method === "POST" && body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

const params = {
  ownerAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  inputAssetKey: FIXTURE_STABLE_KEY,
  outputAssetKey: FIXTURE_STOCK_KEY,
  amountInRaw: "100000000",
  policyId: "STRICT_LIVE",
  maxSlippageBps: 50,
};

describe("POST /a2mcp/verify", () => {
  it("空 body / 缺字段 → 200 status=input_required 带 schema、示例、missingParams（不需要 API key；4xx 会被 OKX 客户端判 endpoint_unreachable）", async () => {
    env = await createTestEnv();
    const empty = await call(env, undefined);
    expect(empty.status).toBe(200);
    expect(empty.json["ok"]).toBe(false);
    expect(empty.json["status"]).toBe("input_required");
    expect(empty.json["error"]).toBe("input_required");
    expect((empty.json["schema"] as { required: string[] }).required).toContain("ownerAddress");
    expect(empty.json["missingParams"]).toEqual(["ownerAddress", "outputAssetKey", "amountInRaw (or amount)"]);
    expect(String(empty.json["summary"])).toMatch(/Missing: ownerAddress/);
    const bareGet = await call(env, undefined, "GET");
    expect(bareGet.status).toBe(200);
    expect(bareGet.json["status"]).toBe("input_required");
    const missing = await call(env, { ownerAddress: params.ownerAddress });
    expect(missing.status).toBe(200);
    expect(missing.json["missingParams"]).toEqual(["outputAssetKey", "amountInRaw (or amount)"]);
    const badStock = await call(env, { ownerAddress: params.ownerAddress, outputAssetKey: "TSLA", amount: "100" });
    expect(badStock.status).toBe(200);
    expect(badStock.json["status"]).toBe("input_required");
    expect((badStock.json["problems"] as Array<{ field: string }>)[0]?.field).toBe("outputAssetKey");
  });

  it("body 不是合法 JSON → 仍是 200 status=input_required（Express 的 entity.parse.failed 默认回 400，会被 OKX 客户端判端点不可达）", async () => {
    env = await createTestEnv();
    const res = await fetch(env.url + "/a2mcp/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not-json",
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as Record<string, unknown>;
    expect(j.status).toBe("input_required");
    expect(j.error).toBe("invalid_json");
    expect(j.example).toBeTruthy();
  });

  it("非 a2mcp 路径的非法 JSON 仍回 400（标准 HTTP 语义只对外放宽，不动 v1 API）", async () => {
    env = await createTestEnv();
    const res = await fetch(env.url + "/v1/jobs", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": TEST_API_KEY },
      body: "not-json",
    });
    expect(res.status).toBe(400);
  });

  it("宽容输入：符号/代码/别名/人类金额/百分比滑点 → 解析并交付；resolvedInput 透明", async () => {
    env = await createTestEnv();
    const stockSymbol = env.service.registry.entries.find((e) => e.role === "stock_output")!.displaySymbol;
    const ticker = env.service.registry.entries.find((e) => e.role === "stock_output")!.underlyingId.split(":")[1]!;
    const stable = env.service.registry.entries.find((e) => e.role === "stable_input")!.displaySymbol;
    const r = await call(env, { wallet: params.ownerAddress, stock: ticker, amount: "100", policy: "strict", slippage: "0.5%", payWith: stable });
    expect(r.status).toBe(200);
    expect(r.json["ok"]).toBe(true);
    expect(r.json["status"]).toBe("delivered");
    expect(r.json["verdict"]).toBe("eligible");
    const resolved = r.json["resolvedInput"] as Record<string, string>;
    expect(resolved["outputAssetKey"]).toContain(stockSymbol);
    expect(resolved["amountInRaw"]).toContain("100000000");
    expect(resolved["policyId"]).toBe("strict → STRICT_LIVE");
    expect(String(r.json["summary"])).toMatch(/^ELIGIBLE under STRICT_LIVE/);
    // 同一意图（符号写法 vs assetKey 写法）→ 同一任务
    const r2 = await call(env, { ...params, maxSlippageBps: 50 });
    expect(r2.json["jobId"]).toBe(r.json["jobId"]);
    // 缺省策略 = REFERENCE_CONTEXT（公开约定）
    const r3 = await call(env, { ownerAddress: params.ownerAddress, outputAssetKey: stockSymbol, amount: "5" });
    expect((r3.json["resolvedInput"] as Record<string, string>)["policyId"]).toMatch(/default REFERENCE_CONTEXT/);
  });

  it("免费：合法参数 → 200 报告；同参再调 → 同一 jobId（幂等，不重复计费）", async () => {
    env = await createTestEnv();
    const r1 = await call(env, params);
    expect(r1.status).toBe(200);
    expect(r1.json["ok"]).toBe(true);
    expect(r1.json["status"]).toBe("delivered");
    expect(r1.json["verdict"]).toBe("eligible");
    expect(r1.json["evidenceMode"]).toBe("FIXTURE");
    const r2 = await call(env, params);
    expect(r2.status).toBe(200);
    expect(r2.json["jobId"]).toBe(r1.json["jobId"]);
    const r3 = await call(env, { ...params, amountInRaw: "50000000" });
    expect(r3.json["jobId"]).not.toBe(r1.json["jobId"]);
  });

  it("收费：→ 402 + PAYMENT-REQUIRED（x402 闸门复用）", async () => {
    env = await createTestEnv({ priceUsd: "0.01" });
    const res = await fetch(env.url + "/a2mcp/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params) });
    expect(res.status).toBe(402);
    expect(res.headers.get("payment-required")).toBeTruthy();
  });

  it("GET 带 query 也可调用（平台 GET↔POST 回退）", async () => {
    env = await createTestEnv();
    const q = new URLSearchParams({ ...params, maxSlippageBps: "50" } as Record<string, string>).toString();
    const res = await fetch(`${env.url}/a2mcp/verify?${q}`);
    expect(res.status).toBe(200);
  });
});

describe("A2MCP 付款凭证不能跨任务复用", () => {
  it("用任务 A 的凭证调不同参数（任务 B）→ 402 payment_proof_reused", async () => {
    env = await createTestEnv({ priceUsd: "0.01" });
    const { buildPaymentHeader } = await import("./helpers");
    const first = await fetch(env.url + "/a2mcp/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(params) });
    expect(first.status).toBe(402);
    const sig = buildPaymentHeader(first.headers.get("payment-required")!);
    const paid = await fetch(env.url + "/a2mcp/verify", { method: "POST", headers: { "content-type": "application/json", "payment-signature": sig }, body: JSON.stringify(params) });
    expect(paid.status).toBe(200);
    const reuse = await fetch(env.url + "/a2mcp/verify", { method: "POST", headers: { "content-type": "application/json", "payment-signature": sig }, body: JSON.stringify({ ...params, amountInRaw: "50000000" }) });
    expect(reuse.status).toBe(402);
    expect(((await reuse.json()) as { error: string }).error).toBe("payment_proof_reused");
    expect(env.control.settleCalls).toBe(1);
  });
});
