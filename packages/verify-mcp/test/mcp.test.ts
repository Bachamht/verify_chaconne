/**
 * I-03：真实 MCP 客户端（官方 SDK Client）经 InMemoryTransport 完成 initialize / 能力协商 / 工具发现 / 调用 / 错误。
 * HTTP 后端用假 fetch 回放 verify-service 的契约响应（含 402 挑战头）。
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { VerifyClient } from "../src/client";
import { createVerifyMcpServer, TOOL_NAMES } from "../src/server";

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: unknown;
}

function fakeBackend(opts: { paid?: boolean } = {}) {
  const seen: Seen[] = [];
  const jobs = new Map<string, { verdict: string }>();
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ method, url, headers, body });
    const json = (status: number, o: unknown, extra: Record<string, string> = {}) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", ...extra } });
    if (!headers["x-api-key"]) return json(401, { error: "missing_api_key" });
    if (url.endsWith("/v1/assets")) return json(200, { registryVersion: "xlayer-registry/1.0.0", registryHash: "0xab", evidenceMode: "LIVE", assets: [{ assetKey: "eip155:196:0x4ae46a509f6b1d9056937ba4500cb143933d2dc8" }] });
    if (url.endsWith("/v1/policies")) return json(200, { policies: [{}, {}, {}], pricing: { reportPriceUsd: opts.paid ? "0.01" : "0" } });
    if (url.endsWith("/v1/jobs") && method === "POST") {
      const id = `job_${(body as { clientRequestId: string }).clientRequestId}`;
      jobs.set(id, { verdict: "eligible" });
      return json(201, { jobId: id, order: { state: opts.paid ? "REPORT_READY" : "PAID", priceUsd: opts.paid ? "0.01" : "0" }, latestReport: { version: 1, verdict: "eligible" }, executions: [] });
    }
    const m = /\/v1\/jobs\/([^/?]+)(\/(report|prepare-execution))?/.exec(url);
    if (m) {
      const id = m[1]!;
      if (!jobs.has(id)) return json(404, { error: "job_not_found" });
      if (m[3] === "report") {
        if (opts.paid && !headers["payment-signature"]) return json(402, { error: "payment_required" }, { "payment-required": "eyJ4NDAyVmVyc2lvbiI6Mn0" });
        return json(200, { report: { reportVersion: 1, verdict: "eligible", comparisonStatus: "live", marketSession: "REGULAR" }, evidence: [{}, {}, {}] }, headers["payment-signature"] ? { "payment-response": "ok" } : {});
      }
      if (m[3] === "prepare-execution") return json(200, { attemptId: "exe_1", state: "PREPARED", reportVersion: 2, refreshesRemaining: 1, execution: { validUntil: "2026-09-21T00:00:00.000Z", typedData: {}, certificate: {}, guardCall: { to: "0x44" } } });
      return json(200, { jobId: id, order: { state: "PAID" }, latestReport: { version: 1, verdict: "eligible" }, executions: [{ attemptId: "exe_1", state: "SUBMITTED", txHash: null, validUntil: null, reportVersion: 2 }] });
    }
    return json(404, { error: "not_found" });
  };
  return { fetchImpl, seen };
}

async function connect(paid = false) {
  const backend = fakeBackend({ paid });
  const server = createVerifyMcpServer({ client: new VerifyClient({ baseUrl: "http://svc", apiKey: "k", caller: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", fetchImpl: backend.fetchImpl }) });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "test-host", version: "0.0.0" });
  await client.connect(ct);
  return { client, backend, close: async () => { await client.close(); await server.close(); } };
}

const params = {
  clientRequestId: "r1",
  ownerAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  inputAssetKey: "eip155:196:0x4ae46a509f6b1d9056937ba4500cb143933d2dc8",
  outputAssetKey: "eip155:196:0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a",
  amountInRaw: "5000000",
  policyId: "STRICT_LIVE",
  maxSlippageBps: 50,
};

describe("MCP 握手与工具发现（I-03）", () => {
  it("initialize 成功；7 个工具且每个有 inputSchema", async () => {
    const { client, close } = await connect();
    const caps = client.getServerCapabilities();
    expect(caps?.tools).toBeDefined();
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const t of tools.tools) expect(t.inputSchema.type).toBe("object");
    await close();
  });
});

describe("工具调用", () => {
  it("prepare_verification → purchase_verification（免费）→ prepare_guard_trade → get_execution_status；请求带 key 与 caller", async () => {
    const { client, backend, close } = await connect();
    const created = await client.callTool({ name: "prepare_verification", arguments: params });
    const sc = created.structuredContent as Record<string, unknown>;
    expect(sc["jobId"]).toBe("job_r1");
    expect(created.isError).toBeFalsy();
    const report = await client.callTool({ name: "purchase_verification", arguments: { jobId: "job_r1" } });
    expect((report.structuredContent as { status: number }).status).toBe(200);
    const prep = await client.callTool({ name: "prepare_guard_trade", arguments: { jobId: "job_r1", refreshKey: "k1" } });
    const p = prep.structuredContent as Record<string, unknown>;
    expect(p["state"]).toBe("PREPARED");
    expect(((prep.content as Array<{ text: string }>)[0]!).text).toContain("owner signs typedData");
    const st = await client.callTool({ name: "get_execution_status", arguments: { jobId: "job_r1" } });
    expect(((st.structuredContent as { executions: unknown[] }).executions).length).toBe(1);
    // 每个请求都带 API key 与调用方地址；prepare_verification 默认 recipient=owner、mode=exactIn
    expect(backend.seen.every((s) => s.headers["x-api-key"] === "k" && s.headers["x-verify-caller"] === params.ownerAddress)).toBe(true);
    const create = backend.seen.find((s) => s.method === "POST" && s.url.endsWith("/v1/jobs"))!;
    expect((create.body as Record<string, unknown>)["recipientAddress"]).toBe(params.ownerAddress);
    expect((create.body as Record<string, unknown>)["mode"]).toBe("exactIn");
    await close();
  });

  it("收费：purchase_verification 无凭证 → 402 挑战（非 isError）；带 paymentSignature → 200 + paymentResponse", async () => {
    const { client, backend, close } = await connect(true);
    await client.callTool({ name: "prepare_verification", arguments: params });
    const challenge = await client.callTool({ name: "purchase_verification", arguments: { jobId: "job_r1" } });
    const c = challenge.structuredContent as Record<string, unknown>;
    expect(c["status"]).toBe(402);
    expect(c["paymentRequired"]).toBe("eyJ4NDAyVmVyc2lvbiI6Mn0");
    expect(challenge.isError).toBeFalsy();
    const paid = await client.callTool({ name: "purchase_verification", arguments: { jobId: "job_r1", paymentSignature: "sig" } });
    const pd = paid.structuredContent as Record<string, unknown>;
    expect(pd["status"]).toBe(200);
    expect(pd["paymentResponse"]).toBe("ok");
    expect(backend.seen.at(-1)!.headers["payment-signature"]).toBe("sig");
    await close();
  });

  it("上游 404 → isError=true 且保留状态；参数非法 → SDK 层拒绝", async () => {
    const { client, close } = await connect();
    const r = await client.callTool({ name: "get_verification", arguments: { jobId: "job_missing" } });
    expect(r.isError).toBe(true);
    expect((r.structuredContent as { status: number }).status).toBe(404);
    const bad = await client.callTool({ name: "prepare_verification", arguments: { ...params, ownerAddress: "not-an-address" } });
    expect(bad.isError).toBe(true);
    await close();
  });
});
