/**
 * V-24：卖出方向的规划
 *  · 方向约定：budget.inputAssetKeys = 你付出的那一侧，legs[].outputAssetKey = 你收到的那一侧。
 *    买入 = 付稳定币收股票；卖出 = 付股票收稳定币。
 *  · 写反了必须是 400 带字段原因，不能一路带到阶梯报价那里炸成 500（原 V-24 现象）。
 *  · 上游报不出价是行情状况，返回 422，同样不是 500。
 */
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURE_STABLE_KEY, FIXTURE_STOCK_KEY } from "@chaconne/core/verify/fixtures";
import { api, createTestEnv, planBody, type TestEnv } from "./helpers";

let env: TestEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const sellBody = (o: Record<string, unknown> = {}) =>
  planBody({
    side: "sell",
    legs: [{ outputAssetKey: FIXTURE_STABLE_KEY, weightBps: 10_000 }],
    budget: { inputAssetKeys: [FIXTURE_STOCK_KEY], amountInRaw: "29344314705268530" },
    clientRequestId: `sell-${Math.random().toString(16).slice(2, 10)}`,
    ...o,
  });

describe("V-24 · 卖出规划的方向", () => {
  it("方向写对（付股票收稳定币）→ 建出规划，且候选的输入就是股票、输出就是稳定币", async () => {
    env = await createTestEnv();
    const r = await api(env, "POST", "/v1/plans", sellBody());
    expect(r.status).toBe(201);
    const planId = r.json["planId"] as string;
    const plan = r.json["plan"] as { candidates: Array<{ candidateId: string; inputAssetKey: string }> };
    expect(plan.candidates.length).toBeGreaterThan(0);
    // 候选只带 inputAssetKey（输出由腿隐含）——付出的那一侧必须是股票
    for (const c of plan.candidates) expect(c.inputAssetKey).toBe(FIXTURE_STOCK_KEY);
    // 真正的下游契约在建出的任务上：evaluate.ts 对卖出要求 input=股票 / output=稳定币，
    // 否则每个候选都会吃两个 REGISTRY_MISMATCH（修复前正是如此）。
    const j = await api(env!, "POST", `/v1/plans/${planId}/jobs`, { candidateId: plan.candidates[0]!.candidateId, clientRequestId: `selljob-${Math.random().toString(16).slice(2, 10)}` });
    expect(j.status).toBe(201);
    const job = (j.json["job"] ?? j.json) as Record<string, unknown>;
    expect(job["inputAssetKey"]).toBe(FIXTURE_STOCK_KEY);
    expect(job["outputAssetKey"]).toBe(FIXTURE_STABLE_KEY);
    expect(job["side"]).toBe("sell");
  });

  it("方向写反（买入形状却标 side=sell）→ 400 wrong_side_for_direction，且点名是哪个字段哪个资产", async () => {
    env = await createTestEnv();
    const r = await api(env, "POST", "/v1/plans", planBody({
      side: "sell",
      clientRequestId: `sellbad-${Math.random().toString(16).slice(2, 10)}`,
    }));
    expect(r.status).toBe(400);
    expect(r.json["error"]).toBe("wrong_side_for_direction");
    const details = r.json["details"] as Array<{ field: string; assetKey: string; expected: string }>;
    expect(details.length).toBe(2);
    expect(details.map((d) => d.field).sort()).toEqual(["budget.inputAssetKeys", "legs.outputAssetKey"]);
    expect(details.find((d) => d.field === "budget.inputAssetKeys")!.expected).toBe("stock_output");
    expect(details.find((d) => d.field === "legs.outputAssetKey")!.expected).toBe("stable_input");
  });

  it("买入方向写反（卖出形状却标 side=buy）→ 同样 400，不是 500", async () => {
    env = await createTestEnv();
    const r = await api(env, "POST", "/v1/plans", sellBody({ side: "buy", clientRequestId: `buybad-${Math.random().toString(16).slice(2, 10)}` }));
    expect(r.status).toBe(400);
    expect(r.json["error"]).toBe("wrong_side_for_direction");
  });

  it("对照：正常买入仍然 201", async () => {
    env = await createTestEnv();
    const r = await api(env, "POST", "/v1/plans", planBody({ clientRequestId: `buy-${Math.random().toString(16).slice(2, 10)}` }));
    expect(r.status).toBe(201);
  });
});
