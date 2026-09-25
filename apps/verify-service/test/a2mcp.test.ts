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

  it("声明 content-encoding: gzip 却发明文 → 200 input_required（此前落到兜底分支回 500）", async () => {
    env = await createTestEnv();
    const res = await fetch(env.url + "/a2mcp/verify", {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "gzip" },
      body: "not-gzip",
    });
    expect(res.status).toBe(200);
    const j = (await res.json()) as Record<string, unknown>;
    expect(j.status).toBe("input_required");
    expect(j.example).toBeTruthy();
  });

  it("body 超过 64kb → 200 input_required（entity.too.large 也是输入侧错误）", async () => {
    env = await createTestEnv();
    const res = await fetch(env.url + "/a2mcp/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ownerAddress: "a".repeat(80_000) }),
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, unknown>).status).toBe("input_required");
  });

  it("OPTIONS /a2mcp/verify → 204 + Allow（此前 404）", async () => {
    env = await createTestEnv();
    const res = await fetch(env.url + "/a2mcp/verify", { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("allow")).toContain("POST");
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
    // FIX-178：过了 60 s 窗口，同参数要重新采证、建新 job（此前自动幂等键没有时限，永远返回第一次的旧报告）
    env.setNow(new Date(Date.parse(env.cfgNow()) + 2 * 60_000).toISOString());
    const r4 = await call(env, params);
    expect(r4.status).toBe(200);
    expect(r4.json["jobId"]).not.toBe(r1.json["jobId"]);
    expect(String(r4.json["ownerPageUrl"])).toMatch(new RegExp(`/jobs/${String(r4.json["jobId"])}$`));
    expect(String(r4.json["summary"])).toContain("My tasks & records");
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

describe("V-39 A2MCP 建的 job 调用方免 key 可回查", () => {
  it("delivered 带绝对 statusUrl / publicUrl / publicBundleUrl；summary 的 URL 在句尾不粘标点；/pub/reports/:shareId 与 /bundle 无 key 200；同 job 同 shareId", async () => {
    env = await createTestEnv({ env: { PUBLIC_BASE_URL: "http://test" } });
    const r = await call(env, params);
    expect(r.json["status"]).toBe("delivered");
    const jobId = r.json["jobId"] as string;
    expect(r.json["statusUrl"]).toBe(`http://test/v1/jobs/${jobId}`);
    expect(String(r.json["publicUrl"])).toMatch(/^http:\/\/test\/pub\/reports\/shr_[0-9a-f]+$/);
    expect(r.json["publicBundleUrl"]).toBe(`${r.json["publicUrl"]}/bundle`);
    expect(String(r.json["summary"])).toMatch(/re-checkable without a key at http:\/\/test\/pub\/reports\/shr_[0-9a-f]+$/);
    expect((r.json["discovery"] as { openapi: string }).openapi).toBe("http://test/pub/openapi.json");
    // 无 key：/v1/jobs/:id 仍是私有的（缺省 401；开放模式下按匿名调用方 → 403/404），公开战报与证据包 200
    expect([401, 403, 404]).toContain((await fetch(`${env.url}/v1/jobs/${jobId}`)).status);
    const pub = await fetch(env.url + new URL(String(r.json["publicUrl"])).pathname);
    expect(pub.status).toBe(200);
    const card = (await pub.json()) as { kind: string; result: { reportHash: string }; verifier: { publicBundleUrl: string }; goal: { amount: string } };
    expect(card.kind).toBe("job");
    expect(card.result.reportHash).toBe(r.json["reportHash"]);
    expect(card.goal.amount).toMatch(/^(< 10|10–100|100–1k|1k–10k|> 10k)$/); // 金额区间化，钱包隐藏
    expect(JSON.stringify(card)).not.toContain(params.ownerAddress.slice(2));
    const bundle = await fetch(env.url + card.verifier.publicBundleUrl);
    expect(bundle.status).toBe(200);
    const b = (await bundle.json()) as { kind: string; id: string; bundleHash: string; bundleSignature: string };
    expect(b.kind).toBe("job");
    expect(b.id).toBe(jobId);
    expect(b.bundleHash).toMatch(/^0x/);
    expect(b.bundleSignature).toMatch(/^0x/);
    // 同参再调 → 同 job、同 shareId（幂等，不重复建分享）
    const again = await call(env, params);
    expect(again.json["shareId"]).toBe(r.json["shareId"]);
    // 不存在 / 未公开的分享 → 404
    expect((await fetch(`${env.url}/pub/reports/shr_nope/bundle`)).status).toBe(404);
  });
});

describe("FIX-174 记录按钱包归属：A2MCP 建的 job，owner 钱包在网页 / MCP 能打开", () => {
  it("网页代理（通配 key + x-verify-caller = owner）读 /v1/jobs/:id → 200；别的钱包 → 404；/v1/records?owner= 列出该 job", async () => {
    env = await createTestEnv({ extraKeys: "vk_web_test:web:*" });
    const r = await call(env, params);
    expect(r.json["status"]).toBe("delivered");
    const jobId = r.json["jobId"] as string;
    const owner = params.ownerAddress;
    const web = (h: Record<string, string>) => ({ "x-api-key": "vk_web_test", ...h });
    const asOwner = await fetch(`${env.url}/v1/jobs/${jobId}`, { headers: web({ "x-verify-caller": owner }) });
    expect(asOwner.status).toBe(200);
    expect(((await asOwner.json()) as { jobId: string }).jobId).toBe(jobId);
    expect((await fetch(`${env.url}/v1/jobs/${jobId}/report`, { headers: web({ "x-verify-caller": owner }) })).status).toBe(200);
    const other = await fetch(`${env.url}/v1/jobs/${jobId}`, { headers: web({ "x-verify-caller": "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" }) });
    expect(other.status).toBe(404);
    const rec = await fetch(`${env.url}/v1/records?owner=${owner}`, { headers: web({ "x-verify-caller": owner }) });
    expect(rec.status).toBe(200);
    const items = ((await rec.json()) as { items: Array<{ kind: string; id: string }> }).items;
    expect(items.some((i) => i.kind === "job" && i.id === jobId)).toBe(true);
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
