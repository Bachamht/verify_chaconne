/** V-43 公开 /healthz 不暴露 contextUrl / crowsnestKeys；?deep=1 需 key */
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

describe("V-43 healthz", () => {
  const full = () => ({ evidenceMode: "fixture", registryVersion: "r", paymentNetwork: "eip155:1952", paid: false, release: { treeHash: "abc" }, startedAt: "2026-09-18T00:00:00.000Z", agent: { c4: true }, agentB: { c1: true, c2: true, crowsnestKeys: ["crowsnest-ctx-k1"], contextUrl: "http://127.0.0.1:8795/context/context.json", playbooks: "playbooks/1.0.0" } });
  it("公开视图：保留 release.treeHash 与能力开关，去掉 contextUrl / crowsnestKeys / startedAt，给 contextConfigured；?deep=1 无 key 401、坏 key 403、好 key 完整对象", async () => {
    env = await createTestEnv({ health: full });
    const pub = await fetch(env.url + "/healthz");
    expect(pub.status).toBe(200);
    const j = (await pub.json()) as Record<string, unknown>;
    expect(j["ok"]).toBe(true);
    expect((j["release"] as { treeHash: string }).treeHash).toBe("abc");
    expect(j["agent"]).toEqual({ c4: true });
    expect(j["agentB"]).toEqual({ c1: true, c2: true, playbooks: "playbooks/1.0.0", contextConfigured: true });
    expect(JSON.stringify(j)).not.toMatch(/127\.0\.0\.1|crowsnest-ctx-k1|startedAt/);
    expect(typeof j["time"]).toBe("string");
    expect((await fetch(env.url + "/healthz?deep=1")).status).toBe(401);
    expect((await api(env, "GET", "/healthz?deep=1", undefined, {}, "wrong")).status).toBe(403);
    const deep = await api(env, "GET", "/healthz?deep=1");
    expect(deep.status).toBe(200);
    expect(deep.json["deep"]).toBe(true);
    expect((deep.json["agentB"] as { contextUrl: string }).contextUrl).toBe("http://127.0.0.1:8795/context/context.json");
    expect(deep.json["startedAt"]).toBe("2026-09-18T00:00:00.000Z");
  });
});

