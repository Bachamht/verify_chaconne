/** V-40 机器可读发现文件：/pub/openapi.json（OpenAPI 3.1）、/pub/llms.txt、/pub/agent-card.json 免 key 200；只描述本部署挂载的路径 */
import { afterEach, describe, expect, it } from "vitest";
import { createTestEnv, type TestEnv } from "./helpers";

let env: TestEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

describe("发现文件", () => {
  it("OpenAPI 3.1：免费端点 + A2MCP 三端点 + /pub 战报；servers 用 PUBLIC_BASE_URL；A2MCP 只有 200/402/429", async () => {
    env = await createTestEnv({ env: { PUBLIC_BASE_URL: "http://test" } });
    const res = await fetch(`${env.url}/pub/openapi.json`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const doc = (await res.json()) as { openapi: string; servers: Array<{ url: string }>; paths: Record<string, Record<string, { security?: unknown[]; responses: Record<string, unknown> }>>; components: { securitySchemes: Record<string, unknown> } };
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.servers[0]!.url).toBe("http://test");
    for (const p of ["/healthz", "/v1/assets", "/v1/policies", "/v1/context", "/v1/events", "/a2mcp/verify", "/a2mcp/plan", "/a2mcp/monitor", "/a2mcp/agent-tasks", "/pub/reports/{shareId}", "/pub/reports/{shareId}/bundle", "/pub/openapi.json", "/pub/llms.txt", "/pub/agent-card.json", "/v1/tasks", "/v1/tasks/{id}/explain-wait"]) expect(doc.paths, p).toHaveProperty(p);
    expect(Object.keys(doc.paths["/a2mcp/verify"]!.post!.responses).sort()).toEqual(["200", "402", "429"]);
    expect(doc.paths["/a2mcp/verify"]!.get).toBeTruthy();
    expect(doc.paths["/v1/assets"]!.get!.security).toEqual([]);
    expect(doc.paths["/v1/tasks"]!.post!.security).toEqual([{ apiKey: [] }]);
    expect(doc.components.securitySchemes).toHaveProperty("apiKey");
    expect(JSON.stringify(doc)).not.toMatch(/127\.0\.0\.1|npx -y/);
    // 同一份也在 /openapi.json（服务直连）
    expect((await fetch(`${env.url}/openapi.json`)).status).toBe(200);
  });

  it("llms.txt 纯文本：说明是什么、免费端点、curl 一次、MCP 仓库路径（不是 npm）；agent card 带端点/鉴权/联系方式", async () => {
    env = await createTestEnv({ env: { PUBLIC_BASE_URL: "http://test" } });
    const txt = await fetch(`${env.url}/pub/llms.txt`);
    expect(txt.status).toBe(200);
    expect(txt.headers.get("content-type")).toContain("text/plain");
    const body = await txt.text();
    expect(body).toMatch(/^# Chaconne Verify/);
    expect(body).toContain("curl -X POST http://test/a2mcp/verify");
    expect(body).toContain("git clone https://github.com/Bachamht/verify_chaconne");
    expect(body).not.toContain("npx -y");
    expect(body).toContain("http://test/pub/openapi.json");
    const card = await fetch(`${env.url}/pub/agent-card.json`);
    expect(card.status).toBe(200);
    const c = (await card.json()) as { name: string; url: string; skills: Array<{ id: string; url: string; auth: string }>; authentication: { schemes: string[] }; contact: { url: string }; openapiUrl: string };
    expect(c.url).toBe("http://test");
    expect(c.openapiUrl).toBe("http://test/pub/openapi.json");
    expect(c.authentication.schemes).toEqual(["none", "apiKey"]);
    expect(c.skills.find((s) => s.id === "verify_once")).toMatchObject({ url: "http://test/a2mcp/verify", auth: "none" });
    expect(c.skills.find((s) => s.id === "create_task")).toMatchObject({ auth: "apiKey" });
    expect(c.contact.url).toBe("http://test");
    expect((await fetch(`${env.url}/.well-known/agent-card.json`)).status).toBe(200);
  });
});
