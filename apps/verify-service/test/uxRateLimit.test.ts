/** V-42 免 key 端点按 IP 限流（RateLimit-* / Retry-After / 429 JSON）；带合法 key 不计；/a2mcp/verify 60 s 内同 (owner, 标的, 金额, 策略) 复用 job */
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

describe("V-42 免 key 端点限流", () => {
  it("3/min：前三次 200 带 RateLimit-Limit/Remaining/Reset，第四次 429 + Retry-After + JSON；同一 IP 跨免费端点共用一个桶；带合法 key 不计；窗口过后恢复", async () => {
    env = await createTestEnv({ env: { FREE_RATE_LIMIT_PER_MIN: "3" } });
    const remaining: string[] = [];
    for (const path of ["/v1/assets", "/v1/policies", "/healthz"]) {
      const res = await fetch(env.url + path);
      expect(res.status, path).toBe(200);
      expect(res.headers.get("ratelimit-limit")).toBe("3");
      remaining.push(res.headers.get("ratelimit-remaining")!);
      expect(Number(res.headers.get("ratelimit-reset"))).toBeGreaterThan(0);
    }
    expect(remaining).toEqual(["2", "1", "0"]);
    const blocked = await fetch(env.url + "/v1/context?tier=agent");
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(blocked.headers.get("ratelimit-remaining")).toBe("0");
    const j = (await blocked.json()) as Record<string, unknown>;
    expect(j["error"]).toBe("rate_limited");
    expect(String(j["message"])).toMatch(/3 requests per 60 s/);
    expect(j["retryAfterSeconds"]).toBeGreaterThan(0);
    // /a2mcp 的 429 沿用 ok:false/status 形态并带 X-A2MCP-Status
    const a = await a2mcp(env, {});
    expect(a.status).toBe(429);
    expect(a.json["status"]).toBe("rate_limited");
    expect(a.headers.get("x-a2mcp-status")).toBe("rate_limited");
    // 带合法 key：不走 IP 桶
    const keyed = await api(env, "GET", "/v1/assets");
    expect(keyed.status).toBe(200);
    expect(keyed.headers.get("ratelimit-limit")).toBeNull();
    // 窗口过后恢复
    env.setNow(new Date(Date.parse(env.cfgNow()) + 61_000).toISOString());
    expect((await fetch(env.url + "/v1/assets")).status).toBe(200);
  });

  it("/a2mcp/verify：60 s 内同 (owner, 标的, 金额, 策略) 复用同一 job（滑点不同也复用，reused=true）；金额不同 → 新 job；61 s 后 → 新 job；显式 clientRequestId 不受影响", async () => {
    env = await createTestEnv();
    const first = await a2mcp(env, verifyParams);
    expect(first.json["status"]).toBe("delivered");
    expect(first.json["reused"]).toBe(false);
    const jobId = first.json["jobId"];
    const again = await a2mcp(env, { ...verifyParams, maxSlippageBps: 60 });
    expect(again.json["jobId"]).toBe(jobId);
    expect(again.json["reused"]).toBe(true);
    expect(String(again.json["reuseNote"])).toMatch(/60 s/);
    const other = await a2mcp(env, { ...verifyParams, amountInRaw: "50000000" });
    expect(other.json["jobId"]).not.toBe(jobId);
    const explicit = await a2mcp(env, { ...verifyParams, clientRequestId: "mine-1" });
    expect(explicit.json["jobId"]).not.toBe(jobId);
    expect(explicit.json["reused"]).toBe(false);
    expect((await a2mcp(env, { ...verifyParams, clientRequestId: "mine-1" })).json["jobId"]).toBe(explicit.json["jobId"]);
    env.setNow(new Date(Date.parse(env.cfgNow()) + 61_000).toISOString());
    const later = await a2mcp(env, { ...verifyParams, maxSlippageBps: 70 });
    expect(later.json["jobId"]).not.toBe(jobId);
    expect(later.json["reused"]).toBe(false);
  });
});

