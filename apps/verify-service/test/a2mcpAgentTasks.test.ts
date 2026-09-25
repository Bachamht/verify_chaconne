/**
 * O 组（OKX 闭环）：
 *  O-02 `POST /a2mcp/agent-tasks` 直连 200 delivered 与 200 input_required（含空探测、GET、非法 JSON）；
 *  O-03 上架状态四字段分别记录（deployments.json）；O-01 免费档 /v1/context 的文档见 verify-web developers 页测试。
 *  O-04 / O-05 是集成阶段的转录（MCP Agent 自驱 + X Layer 回执可追溯），这里只留占位说明，不伪装通过。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EventImpact } from "@chaconne/core/verify";
import { api, createTestEnv, type TestEnv } from "./helpers";

let env: TestEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

async function call(e: TestEnv, body: unknown, method = "POST", rawBody?: string) {
  const res = await fetch(e.url + "/a2mcp/agent-tasks", { method, headers: { "content-type": "application/json" }, body: method === "POST" ? (rawBody ?? (body === undefined ? undefined : JSON.stringify(body))) : undefined });
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

describe("O-02 · POST /a2mcp/agent-tasks", () => {
  it("空 body / GET 空探测 → 200 input_required（schema + example + supportedAssets）；不需要 API key", async () => {
    env = await createTestEnv();
    for (const method of ["POST", "GET"]) {
      const r = await call(env, undefined, method);
      expect(r.status).toBe(200);
      expect(r.json["ok"]).toBe(false);
      expect(r.json["status"]).toBe("input_required");
      expect(r.json["missingParams"]).toEqual(["owner", "assets"]);
      expect(r.json["example"]).toBeTruthy();
      expect((r.json["schema"] as { properties: Record<string, unknown> }).properties).toHaveProperty("assets");
    }
  });

  it("非法 JSON → 200 input_required（沿用 app.ts 错误处理器）；坏地址/未知资产 → 200 input_required 带 problems", async () => {
    env = await createTestEnv();
    const bad = await call(env, undefined, "POST", "{not json");
    expect(bad.status).toBe(200);
    expect(bad.json["status"]).toBe("input_required");
    const badOwner = await call(env, { owner: "0x12" });
    expect(badOwner.json["status"]).toBe("input_required");
    expect((badOwner.json["problems"] as Array<{ field: string }>)[0]!.field).toBe("owner");
    const badAsset = await call(env, { assets: ["ZZZZx"] });
    expect((badAsset.json["problems"] as Array<{ field: string }>)[0]!.field).toBe("assets");
  });

  it("资产集合（符号）→ 200 delivered：事件/影响未接上时字段级 unavailable，任务草案退回标注日期的回放；价格 0", async () => {
    env = await createTestEnv();
    const symbol = env.service.registry.entries.find((e) => e.role === "stock_output" && e.executionAllowed)!.displaySymbol;
    const r = await call(env, { assets: symbol });
    expect(r.status).toBe(200);
    expect(r.json["ok"]).toBe(true);
    expect(r.json["status"]).toBe("delivered");
    expect(r.json["priceUsd"]).toBe("0");
    expect((r.json["events"] as { status: string }).status).toBe("unavailable");
    expect((r.json["eventImpacts"] as { status: string }).status).toBe("not_requested");
    const drafts = r.json["taskDrafts"] as Array<{ mode: string; dateLabel: string; replay: { from: string; to: string } | null; missingForCreate: string[]; draft: { mode: string; params: Record<string, unknown> }; createBody: { playbookId: string; conditions: { hash: string }; mode: string } }>;
    expect(drafts[0]!.mode).toBe("REPLAY");
    expect(drafts[0]!.dateLabel).toBe("2026-09-17");
    expect(drafts[0]!.createBody.mode).toBe("SIMULATION");
    expect(drafts[0]!.createBody.conditions.hash).toMatch(/^0x/);
    // V-25：回放区间不进任务体；没给 owner 时明说还缺 ownerAddress
    expect(drafts[0]!.replay).toMatchObject({ from: "2026-09-17T00:00:00Z", to: "2026-09-17T23:59:59Z" });
    expect(drafts[0]!.draft.params).not.toHaveProperty("from");
    expect(drafts[0]!.missingForCreate).toEqual(["ownerAddress"]);
    expect(JSON.stringify(r.json)).not.toMatch(/will rise|will fall/);
  });

  it("V-25 每个草案原样 POST /v1/tasks → 201（有事件与无事件两种；draft 与 createBody 相同）", async () => {
    const owner = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    for (const withEvents of [false, true]) {
      env = await createTestEnv(withEvents ? { agentHooks: { events: async () => [{ id: "crowsnest:MACRO_TIER1:2026-09-18:fomc", kind: "MACRO_TIER1", name: "FOMC", underlyingIds: [], scheduledAtUtc: "2026-09-18T18:00:00Z", dateLocal: "2026-09-18", datePrecision: "exact", sessionHint: null, status: "confirmed", revision: 1, source: "crowsnest", sourceFetchedAt: "2026-09-18T00:00:00Z", firstKnownAt: "2026-09-01T00:00:00Z", tz: "America/New_York" }] } } : {});
      const r = await call(env, { owner, horizonHours: 48 });
      expect(r.json["status"]).toBe("delivered");
      const drafts = r.json["taskDrafts"] as Array<{ kind: string; draft: Record<string, unknown>; createBody: Record<string, unknown>; missingForCreate: string[] }>;
      expect(drafts.length).toBeGreaterThan(0);
      expect(drafts.map((x) => x.kind)).toContain(withEvents ? "event" : "replay");
      for (const t of drafts) {
        expect(t.missingForCreate).toEqual([]);
        expect(t.createBody).toEqual(t.draft);
        const created = await api(env, "POST", "/v1/tasks", t.draft);
        expect(created.status, JSON.stringify(created.json).slice(0, 300)).toBe(201);
        expect((created.json["task"] as { status: string; playbookId: string }).playbookId).toBe(t.draft["playbookId"]);
        expect(created.json["mandateDraft"]).toBeNull(); // SIMULATION：不需要签名
      }
      await env.close();
      env = null;
    }
  });

  it("owner + Lane D 钩子接上 → eventImpacts.status=ok，事件任务草案；GET 带 query 也可", async () => {
    env = await createTestEnv({
      agentHooks: {
        impacts: async (): Promise<EventImpact[]> => [{ eventId: "e1", relation: "macro_research", assets: [], holdings: [{ assetKey: "x", balanceRaw: "1" }], tasks: [], actions: ["view_evidence"] }],
        events: async () => [{ id: "crowsnest:MACRO_TIER1:2026-09-18:fomc", kind: "MACRO_TIER1", name: "FOMC", underlyingIds: [], scheduledAtUtc: "2026-09-18T18:00:00Z", dateLocal: "2026-09-18", datePrecision: "exact", sessionHint: null, status: "confirmed", revision: 1, source: "crowsnest", sourceFetchedAt: "2026-09-18T00:00:00Z", firstKnownAt: "2026-09-01T00:00:00Z", tz: "America/New_York" }],
      },
    });
    const owner = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const res = await fetch(`${env.url}/a2mcp/agent-tasks?owner=${owner}&horizonHours=24`);
    expect(res.status).toBe(200);
    const j = (await res.json()) as Record<string, unknown>;
    expect(j["status"]).toBe("delivered");
    expect((j["eventImpacts"] as { status: string; items: unknown[] }).status).toBe("ok");
    expect((j["events"] as { status: string; count: number }).count).toBe(1);
    expect((j["taskDrafts"] as Array<{ kind: string; createBody: { ownerAddress: string } }>)[0]).toMatchObject({ kind: "event", createBody: { ownerAddress: owner } });
  });
});

describe("O-03 · 上架状态分别记录", () => {
  it("deployments.json 的三个 A2MCP 服务各有 listed / applied / directCallable / paidSuccess 四个布尔字段，且互不推导", () => {
    // 私有单仓在 docs/devday-2026/，公开快照在 docs/
    const docFile = (name: string) => [join(__dirname, "..", "..", "..", "docs", "devday-2026", name), join(__dirname, "..", "..", "..", "docs", name)].find((f) => existsSync(f))!;
    const d = JSON.parse(readFileSync(docFile("deployments.json"), "utf8")) as { services: Record<string, Record<string, unknown>> };
    for (const k of ["verifyStockProof", "verifyPlanMonitor", "verifyAgentTasks"]) {
      const s = d.services[k]!;
      for (const f of ["listed", "applied", "directCallable", "paidSuccess"]) expect(typeof s[f], `${k}.${f}`).toBe("boolean");
    }
    expect(d.services["verifyAgentTasks"]!["applied"]).toBe(true); // 2026-09-26 作为 #13803 的第二项服务提交审核
    expect(d.services["verifyAgentTasks"]!["listed"]).toBe(false); // 已提交 ≠ 已上线
    expect(d.services["verifyStockProof"]!["listed"]).toBe(true); // 2026-09-24 上架通过
    const plan = JSON.parse(readFileSync(docFile("asp-service-plan.json"), "utf8")) as { agentTasksService: { service: Record<string, unknown> } };
    for (const f of ["whatItIs", "whatYouGet", "whatNoResultMeans", "limits"]) expect(plan.agentTasksService.service).toHaveProperty(f);
  });
  it.todo("O-04 MCP Agent 自驱转录（建任务→等待→执行→证据包→验证）— 集成阶段由 Lane I 用 scripts/e2eAgentTask.ts 产出");
  it.todo("O-05 X Layer 回执与决策证据在复盘中可追溯 — 集成阶段核对 recap.timeline.txHash 与 bundle");
});
