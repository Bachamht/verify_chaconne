/** V-41 /a2mcp/* 响应头 X-A2MCP-Status；错误 message 英文 + messageZh */
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURE_STABLE_KEY, FIXTURE_STOCK_KEY } from "@chaconne/core/verify/fixtures";
import { api, createTestEnv, TEST_API_KEY, type TestEnv } from "./helpers";

let env: TestEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const owner = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const verifyParams = { ownerAddress: owner, inputAssetKey: FIXTURE_STABLE_KEY, outputAssetKey: FIXTURE_STOCK_KEY, amountInRaw: "100000000", policyId: "STRICT_LIVE", maxSlippageBps: 50 };
const a2mcp = async (e: TestEnv, body: unknown) => {
  const res = await fetch(e.url + "/a2mcp/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { status: res.status, headers: res.headers, json: (await res.json()) as Record<string, unknown> };
};

describe("V-41 A2MCP 状态头与英文错误", () => {
  it("X-A2MCP-Status: input_required / delivered 镜像正文，正文与状态码不变（仍 200）", async () => {
    env = await createTestEnv();
    const empty = await a2mcp(env, {});
    expect(empty.status).toBe(200);
    expect(empty.headers.get("x-a2mcp-status")).toBe("input_required");
    expect(empty.json["status"]).toBe("input_required");
    const ok = await a2mcp(env, verifyParams);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("x-a2mcp-status")).toBe("delivered");
    const badJson = await fetch(env.url + "/a2mcp/verify", { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    expect(badJson.headers.get("x-a2mcp-status")).toBe("input_required");
    const tasks = await fetch(env.url + "/a2mcp/agent-tasks");
    expect(tasks.headers.get("x-a2mcp-status")).toBe("input_required");
    const plan = await fetch(env.url + "/a2mcp/plan");
    expect(plan.headers.get("x-a2mcp-status")).toBe("input_required");
  });

  it("v1 错误：message 英文、messageZh 保留中文、code/details 不变（/v1/tasks 缺字段、compare-policies 缺 variants）", async () => {
    env = await createTestEnv();
    const t = await api(env, "POST", "/v1/tasks", { clientRequestId: "x", playbookId: "session_dca", mode: "SIMULATION", ownerAddress: owner, params: { steps: 1 } });
    expect(t.status).toBe(400);
    expect(t.json["error"]).toBe("invalid_playbook_params");
    expect(t.json["message"]).toBe("Playbook parameter validation failed");
    expect(t.json["messageZh"]).toBe("模板参数校验失败");
    expect((t.json["details"] as Array<{ field: string; code: string }>).map((d) => d.field)).toEqual(expect.arrayContaining(["inputAssetKey", "outputAssetKey", "perStepAmountRaw"]));
    const missing = await api(env, "POST", "/v1/tasks", {});
    expect(missing.json["message"]).toBe("Task request validation failed");
    expect(missing.json["messageZh"]).toBe("任务请求校验失败");
    // 没有中文的 message 原样；code 也不会被翻译
    const nf = await api(env, "GET", "/v1/jobs/job_nope");
    expect(nf.status).toBe(404);
    expect(nf.json["message"]).toBe("Job not found");
    expect(nf.json["messageZh"]).toBeUndefined();
    // A2MCP 上的 400 → 200 input_required 也英文优先
    const bad = await a2mcp(env, { ...verifyParams, maxSlippageBps: 999 });
    expect(bad.status).toBe(200);
    expect(bad.json["status"]).toBe("input_required");
    expect(JSON.stringify(bad.json)).not.toMatch(/"message":"[^"]*[一-鿿]/);
    expect(TEST_API_KEY).toBeTruthy();
  });
});
