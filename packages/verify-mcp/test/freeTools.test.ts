/**
 * V-40：没有 VERIFY_API_KEY 也能启动并工作——免费端点的工具照常调用，需 key 的工具回结构化 not_available(api_key_required)
 * 而不是打上游 401；三个 A2MCP 免 key 工具（verify_once_free / plan_free / agent_tasks_free）把 200-only 传输映射成 delivered / input_required。
 */
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { FREE_PATH_RE, VerifyClient } from "../src/client";
import { createVerifyMcpServer, FREE_TOOL_NAMES, TOOL_NAMES } from "../src/server";
import { TOOL_NAMES_FREE } from "../src/toolsFree";

function backend() {
  const seen: Array<{ method: string; url: string; headers: Record<string, string>; body: unknown }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const path = new URL(url).pathname;
    const method = init?.method ?? "GET";
    const headers = Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {}));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ method, url, headers, body });
    const json = (status: number, o: unknown) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
    if (path === "/v1/assets") return json(200, { registryVersion: "r", registryHash: "0x", evidenceMode: "FIXTURE", assets: [] });
    if (path === "/v1/context") return json(200, { packagedAt: "2026-09-18T15:00:00Z", session: { label: { value: "US_REGULAR", status: "ok" } }, events: [] });
    if (path === "/a2mcp/verify") {
      const b = (body ?? {}) as Record<string, unknown>;
      if (!b["outputAssetKey"]) return json(200, { ok: false, status: "input_required", missingParams: ["outputAssetKey"], problems: [], schema: {}, example: {} });
      return json(200, { ok: true, status: "delivered", summary: "ELIGIBLE under REFERENCE_CONTEXT. Evidence is re-checkable at http://svc/pub/reports/shr_1", jobId: "job_1", publicUrl: "http://svc/pub/reports/shr_1" });
    }
    if (path === "/a2mcp/agent-tasks") return json(200, { ok: true, status: "delivered", taskDrafts: [{ draft: {} }], events: { status: "unavailable" }, eventImpacts: { status: "not_requested" } });
    if (path.startsWith("/v1/")) return json(401, { error: "missing_api_key" });
    return json(404, { error: "not_found" });
  };
  return { fetchImpl, seen };
}

async function connect(apiKey: string) {
  const b = backend();
  const server = createVerifyMcpServer({ client: new VerifyClient({ baseUrl: "http://svc", apiKey, fetchImpl: b.fetchImpl }) });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: "t", version: "0" });
  await client.connect(ct);
  return { client, b, close: async () => { await client.close(); await server.close(); } };
}
const sc = (r: Awaited<ReturnType<Client["callTool"]>>) => r.structuredContent as Record<string, unknown>;

describe("免 key 只读模式", () => {
  it("无 VERIFY_API_KEY：服务器照常启动、46 个工具全部可见；免费工具正常调用且不带 x-api-key", async () => {
    const { client, b, close } = await connect("");
    const names = (await client.listTools()).tools.map((t) => t.name);
    expect(names.sort()).toEqual([...TOOL_NAMES].sort());
    for (const n of TOOL_NAMES_FREE) expect(FREE_TOOL_NAMES).toContain(n);
    const assets = await client.callTool({ name: "list_supported_assets", arguments: {} });
    expect(assets.isError).toBeFalsy();
    expect(sc(assets)["evidenceMode"]).toBe("FIXTURE");
    const ctx = await client.callTool({ name: "get_market_context", arguments: { tier: "agent" } });
    expect(ctx.isError).toBeFalsy();
    expect((ctx.content as Array<{ text: string }>)[0]!.text).toContain("US_REGULAR");
    expect(b.seen.every((s) => !("x-api-key" in s.headers))).toBe(true);
    await close();
  });

  it("需 key 的工具 → not_available(api_key_required)，isError=false，且不打上游", async () => {
    const { client, b, close } = await connect("");
    const before = b.seen.length;
    for (const [name, args] of [["create_task", { clientRequestId: "x", ownerAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", playbookId: "session_dca", params: {}, conditions: { version: "conditions/1", items: [{ type: "session" }] } }], ["get_task", { taskId: "tsk_1" }], ["prepare_verification", { clientRequestId: "r", ownerAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", inputAssetKey: "eip155:196:0x4ae46a509f6b1d9056937ba4500cb143933d2dc8", outputAssetKey: "eip155:196:0x9d275685dc284c8eb1c79f6aba7a63dc75ec890a", amountInRaw: "1", policyId: "STRICT_LIVE", maxSlippageBps: 50 }], ["get_portfolio", { owner: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }]] as const) {
      const r = await client.callTool({ name, arguments: args as Record<string, unknown> });
      expect(r.isError, name).toBeFalsy();
      expect(sc(r)["status"], name).toBe("not_available");
      expect(sc(r)["reason"], name).toBe("api_key_required");
      expect((r.content as Array<{ text: string }>)[0]!.text).toMatch(/VERIFY_API_KEY/);
    }
    expect(b.seen.length).toBe(before);
    await close();
  });

  it("verify_once_free：缺参 → status=input_required（不是错误）；齐参 → delivered 带 publicUrl；agent_tasks_free → delivered", async () => {
    const { client, b, close } = await connect("");
    const missing = await client.callTool({ name: "verify_once_free", arguments: { ownerAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } });
    expect(missing.isError).toBeFalsy();
    expect(sc(missing)["status"]).toBe("input_required");
    expect((missing.content as Array<{ text: string }>)[0]!.text).toContain("missing outputAssetKey");
    const ok = await client.callTool({ name: "verify_once_free", arguments: { ownerAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", outputAssetKey: "AAPLx", amount: "100" } });
    expect(sc(ok)["status"]).toBe("delivered");
    expect(sc(ok)["publicUrl"]).toBe("http://svc/pub/reports/shr_1");
    expect(b.seen.at(-1)!.headers["x-api-key"]).toBeUndefined();
    const tasks = await client.callTool({ name: "agent_tasks_free", arguments: { assets: ["AAPLx"] } });
    expect((tasks.content as Array<{ text: string }>)[0]!.text).toContain("1 draft(s)");
    await close();
  });

  it("有 key 时免 key 工具仍不带 key（平台约定）；FREE_PATH_RE 只放行免费路径", async () => {
    const { client, b, close } = await connect("k");
    await client.callTool({ name: "verify_once_free", arguments: { ownerAddress: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", outputAssetKey: "AAPLx", amount: "1" } });
    expect(b.seen.at(-1)!.headers["x-api-key"]).toBeUndefined();
    await close();
    for (const p of ["/v1/assets", "/v1/context?tier=agent", "/v1/events", "/a2mcp/verify", "/pub/reports/shr_1", "/healthz"]) expect(FREE_PATH_RE.test(p), p).toBe(true);
    for (const p of ["/v1/tasks", "/v1/jobs/job_1", "/v1/eventsx", "/v1/portfolio/0x"]) expect(FREE_PATH_RE.test(p), p).toBe(false);
  });
});
