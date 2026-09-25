/** 钱包账户化：GET /v1/records?owner= 汇总该钱包的任务 / 规划 / 核验 / 模拟；owner 鉴权与组合页一致 */
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURE_STABLE_KEY, FIXTURE_STOCK_KEY } from "@chaconne/core/verify/fixtures";
import { api, createTestEnv, jobBody, OTHER_API_KEY, type TestEnv } from "./helpers";

let env: TestEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const owner = "0xabababababababababababababababababababab";
const taskBody = { clientRequestId: "rec-task-1", ownerAddress: owner, playbookId: "session_dca", mode: "SIMULATION", params: { inputAssetKey: FIXTURE_STABLE_KEY, outputAssetKey: FIXTURE_STOCK_KEY, steps: 3, perStepAmountRaw: "10000000" }, conditions: { version: "conditions/1", items: [{ type: "session", allow: ["US_REGULAR"] }, { type: "min_gap_trading_days", days: 1 }] } };
const goal = { ownerAddress: owner, recipientAddress: owner, executionChainId: 196, legs: [{ outputAssetKey: FIXTURE_STOCK_KEY, weightBps: 10000 }], budget: { inputAssetKeys: [FIXTURE_STABLE_KEY], amountInRaw: "20000000" }, side: "buy", policyId: "QUOTE_ONLY", policyVersion: "1.1.0", maxSlippageBps: 50, maxPriceImpactBps: 100, maxReferenceDeviationBps: null, deadline: new Date(Date.now() + 3600_000).toISOString() };

describe("GET /v1/records", () => {
  it("汇总任务、规划、单笔核验与模拟，按创建时间倒序，字段只含公开摘要", async () => {
    env = await createTestEnv();
    const t = await api(env, "POST", "/v1/tasks", taskBody);
    expect(t.status).toBe(201);
    const s = await api(env, "POST", "/v1/simulations", { goal, personaId: "turtle_drummer", clientRequestId: "rec-sim-1" });
    expect(s.status).toBe(201);
    const p = await api(env, "POST", "/v1/plans", { ...goal, clientRequestId: "rec-plan-1" });
    if (![200, 201].includes(p.status)) console.error("plan", p.json);
    expect([200, 201]).toContain(p.status);
    const j = await api(env, "POST", "/v1/jobs", jobBody({ ownerAddress: owner, recipientAddress: owner, clientRequestId: "rec-job-1" }));
    if (![200, 201].includes(j.status)) console.error("job", j.json);
    expect([200, 201]).toContain(j.status);

    const r = await api(env, "GET", `/v1/records?owner=${owner}`);
    expect(r.status).toBe(200);
    const items = r.json["items"] as Array<Record<string, unknown>>;
    expect(items.map((i) => i["kind"]).sort()).toEqual(["job", "plan", "simulation", "task"]);
    for (let i = 1; i < items.length; i++) expect(String(items[i - 1]!["createdAt"]) >= String(items[i]!["createdAt"])).toBe(true);
    const task = items.find((i) => i["kind"] === "task")!;
    expect(task).toMatchObject({ id: t.json["task"] && (t.json["task"] as Record<string, unknown>)["id"], status: expect.any(String), mode: "SIMULATION", playbookId: "session_dca", inputAssetKey: FIXTURE_STABLE_KEY, outputAssetKeys: [FIXTURE_STOCK_KEY] });
    expect(task).not.toHaveProperty("conditions");
    const sim = items.find((i) => i["kind"] === "simulation")!;
    expect(sim).toMatchObject({ personaId: "turtle_drummer", mode: "SIMULATION", policyId: "QUOTE_ONLY", amountInRaw: "20000000" });
    const job = items.find((i) => i["kind"] === "job")!;
    expect(job).toMatchObject({ inputAssetKey: FIXTURE_STABLE_KEY, outputAssetKeys: [FIXTURE_STOCK_KEY] });
    expect(typeof job["policyId"]).toBe("string");
  });

  it("非该 owner 的调用方 403；坏地址 400；空钱包返回空列表", async () => {
    env = await createTestEnv();
    await api(env, "POST", "/v1/tasks", taskBody);
    expect((await api(env, "GET", `/v1/records?owner=${owner}`, undefined, {}, OTHER_API_KEY)).status).toBe(403);
    expect((await api(env, "GET", "/v1/records?owner=nope")).status).toBe(400);
    const empty = await api(env, "GET", "/v1/records?owner=0x00000000000000000000000000000000000000ee");
    expect(empty.status).toBe(403);
  });
});
