/**
 * v7 Lane A · 鉴权模型（D-093 / CV-D25）：
 *  SEC-01 服务 key 不是运营者；SEC-02 枚举 express 上注册的全部路由——agent:hosted 只能到达白名单，且只对令牌绑定的托管任务生效
 *  （理由卡 / Lab / 上下文各一例）；SEC-03 executor:hosted 除 /v1/executor/* 外全部 403；SEC-09 服务 key 不能建任务、不能代 owner 写入；
 *  A-16 轮次令牌：A 的令牌操作 B → 403；租约过期 / 旧 attempt → 409；没有令牌 → 403。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Express, Response } from "express";
import { eq } from "drizzle-orm";
import { verifyTasks } from "@chaconne/db";
import { isOperator, serviceKeyMatcher } from "../src/http/auth";
import { AGENT_ROUTE_ALLOWLIST, matchServiceRoute } from "../src/agent/routeGuard";
import { STOCK, asAgent, asExecutor, asOwner, call, claimFor, createV7AEnv, hostedTask, sha256, AGENT_KEY, EXEC_KEY, OWNER_ADDR, type V7AEnv } from "./v7a.helpers";

let env: V7AEnv;
let taskA: string;
let taskB: string;
let thesisA: string;
let thesisB: string;
let tokenA: string;
let runA: string;

beforeAll(async () => {
  env = await createV7AEnv();
  taskA = await hostedTask(env, "sec-a");
  taskB = await hostedTask(env, "sec-b");
  thesisA = (await env.tasks.byId(taskA))!.thesisId!;
  thesisB = (await env.tasks.byId(taskB))!.thesisId!;
  const run = await claimFor(env, taskA);
  tokenA = run.runToken;
  runA = run.runId;
});
afterAll(async () => {
  await env?.close();
});

type Layer = { route?: { path: unknown; methods: Record<string, boolean> } };
function routesOf(app: Express): Array<{ method: string; path: string }> {
  const stack = ((app as unknown as { router: { stack: Layer[] } }).router.stack ?? []) as Layer[];
  const out: Array<{ method: string; path: string }> = [];
  for (const l of stack) {
    if (!l.route) continue;
    const paths = Array.isArray(l.route.path) ? l.route.path : [l.route.path];
    for (const p of paths) {
      if (typeof p !== "string") continue;
      for (const [m, on] of Object.entries(l.route.methods)) if (on && m !== "_all") out.push({ method: m.toUpperCase(), path: p });
    }
  }
  return out;
}
function concrete(path: string): string {
  return path
    .replace(/^\/v1\/tasks\/:id/, `/v1/tasks/${taskA}`)
    .replace(/^\/v1\/theses\/:id/, `/v1/theses/${thesisA}`)
    .replace(/^\/v1\/agent\/runs\/:runId/, `/v1/agent/runs/${runA}`)
    .replace(/:owner/g, OWNER_ADDR)
    .replace(/:[A-Za-z]+/g, "x");
}

describe("SEC-02 / SEC-03：枚举 express 上注册的全部路由", () => {
  it("agent:hosted 只到达白名单路由；白名单外全部 403 service_route_forbidden（到不了服务自己的鉴权）", async () => {
    const routes = routesOf(env.app);
    expect(routes.length).toBeGreaterThan(90);
    const reached: string[] = [];
    const denied: string[] = [];
    for (const r of routes) {
      const p = concrete(r.path);
      const allowed = matchServiceRoute("agent:hosted", r.method, p.split("?")[0]!) !== null;
      const res = await call(env, r.method, p, r.method === "GET" ? undefined : {}, asAgent(tokenA));
      if (allowed) {
        expect(res.json["error"], `${r.method} ${r.path} should pass the guard`).not.toBe("service_route_forbidden");
        reached.push(`${r.method} ${r.path}`);
      } else {
        expect(res.status, `${r.method} ${r.path}`).toBe(403);
        expect(res.json["error"], `${r.method} ${r.path}`).toBe("service_route_forbidden");
        denied.push(`${r.method} ${r.path}`);
      }
    }
    // 建任务、事件影响动作、授权计划、组合、通知、资金组、调仓、key、理由卡创建、Lab 对照都被挡
    for (const must of ["POST /v1/tasks", "POST /v1/event-impacts/actions", "POST /v1/mandates", "GET /v1/portfolio/:owner", "POST /v1/notify/webhooks", "POST /v1/budget-groups", "POST /v1/rebalance/plans", "GET /v1/keys", "POST /v1/theses", "POST /v1/tasks/:id/compare-policies", "POST /v1/tasks/:id/pause", "POST /v1/tasks/:id/authorize", "POST /v1/tasks/:id/brief", "POST /v1/tasks/:id/conditions", "GET /v1/tasks/:id", "POST /v1/events/earnings/ingest", "POST /v1/context/ingest", "DELETE /v1/tasks/:id"]) expect(denied).toContain(must);
    for (const must of ["POST /v1/agent/claim", "POST /v1/tasks/:id/intents", "POST /v1/tasks/:id/agent-status", "GET /v1/tasks/:id/agent-context", "POST /v1/tasks/:id/quotes", "POST /v1/theses/:id/review-items", "GET /v1/tasks/:id/explain-wait", "GET /v1/context"]) expect(reached).toContain(must);
  });

  it("executor:hosted 除 /v1/executor/* 外全部 403（含建任务、事件影响动作、授权计划、组合、通知、免费端点）", async () => {
    for (const r of routesOf(env.app)) {
      if (r.path.startsWith("/v1/executor/")) continue;
      const res = await call(env, r.method, concrete(r.path), r.method === "GET" ? undefined : {}, asExecutor());
      expect(res.status, `${r.method} ${r.path}`).toBe(403);
      expect(res.json["error"]).toBe("service_route_forbidden");
    }
    expect(matchServiceRoute("executor:hosted", "POST", "/v1/executor/claim")).not.toBeNull();
  });

  it("白名单只含 §2.8 H 路由、agent_write 路由、免费端点与 /v1/agent/*（快照）", () => {
    expect(AGENT_ROUTE_ALLOWLIST.map((r) => `${r.method} ${r.route}`)).toMatchSnapshot();
  });
});

describe("SEC-02：只对令牌绑定的托管任务生效（理由卡 / Lab / 上下文各一例）", () => {
  it("任务路由：A 的令牌 → A 通过；→ B 403 run_token_task_mismatch", async () => {
    expect((await call(env, "GET", `/v1/tasks/${taskA}/agent-context`, undefined, asAgent(tokenA))).status).toBe(200);
    const r = await call(env, "GET", `/v1/tasks/${taskB}/agent-context`, undefined, asAgent(tokenA));
    expect(r.status).toBe(403);
    expect(r.json["error"]).toBe("run_token_task_mismatch");
  });
  it("理由卡 review-items：B 的卡 → 403；A 的卡 → 通过守卫（服务层按 agent_write 放行）", async () => {
    const rb = await call(env, "POST", `/v1/theses/${thesisB}/review-items`, { side: "support", text: "x", sourceUrl: "https://www.bls.gov/x" }, asAgent(tokenA));
    expect(rb.status).toBe(403);
    expect(rb.json["error"]).toBe("run_token_task_mismatch");
    const ra = await call(env, "GET", `/v1/theses/${thesisA}`, undefined, asAgent(tokenA));
    expect(ra.status).toBe(200);
  });
  it("Lab explain-wait：A → 200；B → 403", async () => {
    expect((await call(env, "GET", `/v1/tasks/${taskA}/explain-wait`, undefined, asAgent(tokenA))).status).toBe(200);
    expect((await call(env, "GET", `/v1/tasks/${taskB}/explain-wait`, undefined, asAgent(tokenA))).status).toBe(403);
  });
  it("上下文 /v1/context?taskId：A → 200；B → 403；不带 taskId = 免费档", async () => {
    expect((await call(env, "GET", `/v1/context?taskId=${taskA}`, undefined, asAgent(tokenA))).status).toBe(200);
    expect((await call(env, "GET", `/v1/context?taskId=${taskB}`, undefined, asAgent(tokenA))).status).toBe(403);
    expect((await call(env, "GET", `/v1/context`, undefined, asAgent())).status).toBe(200);
  });
  it("任务被切出托管（agent_mode ≠ hosted）后，令牌仍有效也读不到：服务层 403 task_forbidden", async () => {
    await env.db.update(verifyTasks).set({ agentMode: "byo" }).where(eq(verifyTasks.id, taskA));
    const r = await call(env, "GET", `/v1/tasks/${taskA}/agent-context`, undefined, asAgent(tokenA));
    expect(r.status).toBe(403);
    expect(r.json["error"]).toBe("task_forbidden");
    await env.db.update(verifyTasks).set({ agentMode: "hosted" }).where(eq(verifyTasks.id, taskA));
  });
  it("owner（网站 / 自己的 key）照常读写自己的任务；别的调用方 403", async () => {
    expect((await call(env, "GET", `/v1/tasks/${taskA}/agent-context`, undefined, asOwner())).status).toBe(200);
    expect((await call(env, "GET", `/v1/tasks/${taskA}/agent-context`, undefined, { "x-api-key": "vk_test_beta" })).status).toBe(403);
  });
});

describe("SEC-01 / SEC-09：服务 key 不是运营者、不代表 owner", () => {
  it("isOperator 对 authKind=service 恒为 false；配置表 key 才算", () => {
    const res = (locals: Record<string, unknown>) => ({ locals }) as unknown as Response;
    expect(isOperator(res({ authKind: "service", callerId: "agent:hosted" }))).toBe(false);
    expect(isOperator(res({ authKind: "key", callerId: "agent:hosted" }))).toBe(false);
    expect(isOperator(res({ authKind: "key", callerId: "ops" }))).toBe(true);
  });
  it("运营者端点（财报摄入）与建任务对两把服务 key 都 403；TasksService.ownerOf 拒绝服务调用方", async () => {
    for (const h of [asAgent(tokenA), asExecutor()]) {
      expect((await call(env, "POST", "/v1/events/earnings/ingest", {}, h)).status).toBe(403);
      const t = await call(env, "POST", "/v1/tasks", { clientRequestId: "svc-1", ownerAddress: OWNER_ADDR, mode: "SIMULATION", scope: { objective: "x", outputAssetKeys: [STOCK], budgetCapRaw: "1", perStepCapRaw: "1" } }, h);
      expect(t.status).toBe(403);
    }
    expect(() => env.tasks.ownerOf("agent:hosted", OWNER_ADDR)).toThrow(/service callers/);
    expect(() => env.tasks.ownerOf("executor:hosted", OWNER_ADDR)).toThrow(/service callers/);
  });
  it("服务 key 只比对 SHA-256（常量时间）；明文不在配置；未知 key 走旧路径 403 invalid_api_key", async () => {
    const m = serviceKeyMatcher({ executor: sha256(EXEC_KEY), agent: sha256(AGENT_KEY) });
    expect(m(AGENT_KEY)).toBe("agent:hosted");
    expect(m(EXEC_KEY)).toBe("executor:hosted");
    expect(m(`${AGENT_KEY}x`)).toBeNull();
    expect(serviceKeyMatcher({ executor: "", agent: "" })(AGENT_KEY)).toBeNull();
    expect(env.cfg.VERIFY_HOSTED_AGENT_KEY_SHA256).not.toContain(AGENT_KEY);
    const r = await call(env, "GET", `/v1/tasks/${taskA}`, undefined, { "x-api-key": `${AGENT_KEY}x` });
    expect(r.status).toBe(403);
    expect(r.json["error"]).toBe("invalid_api_key");
  });
});

describe("A-16 轮次令牌", () => {
  it("没有令牌的 agent:hosted 任务请求 → 403 run_token_required；伪造令牌 → 403", async () => {
    const r = await call(env, "GET", `/v1/tasks/${taskA}/agent-context`, undefined, asAgent());
    expect(r.status).toBe(403);
    expect(r.json["error"]).toBe("run_token_required");
    const f = await call(env, "GET", `/v1/tasks/${taskA}/agent-context`, undefined, asAgent(`rt1.${runA}.1.${"0".repeat(64)}`));
    expect(f.status).toBe(403);
    expect(f.json["error"]).toBe("run_token_invalid");
  });
  it("轮次接口：别的 runId → 403；租约过期 → 409；重新领取后旧 attempt 的令牌 → 409", async () => {
    const other = await call(env, "POST", `/v1/agent/runs/run_${"ab".repeat(12)}/checkpoint`, { attempt: 1 }, asAgent(tokenA));
    expect(other.status).toBe(403);
    const t = await hostedTask(env, "sec-lease");
    const run = await claimFor(env, t);
    const start = env.cfgNow();
    env.setNow(new Date(Date.parse(start) + 241_000).toISOString());
    const expired = await call(env, "GET", `/v1/tasks/${t}/agent-context`, undefined, asAgent(run.runToken));
    expect(expired.status).toBe(409);
    expect(expired.json["error"]).toBe("run_token_expired");
    const again = await call(env, "POST", "/v1/agent/claim", { worker: "w2", max: 5 }, asAgent());
    const run2 = (again.json["runs"] as Array<{ taskId: string; attempt: number; runToken: string }>).find((x) => x.taskId === t)!;
    expect(run2.attempt).toBe(2);
    const stale = await call(env, "GET", `/v1/tasks/${t}/agent-context`, undefined, asAgent(run.runToken));
    expect(stale.status).toBe(409);
    expect(stale.json["error"]).toBe("run_token_stale_attempt");
    expect((await call(env, "GET", `/v1/tasks/${t}/agent-context`, undefined, asAgent(run2.runToken))).status).toBe(200);
    env.setNow(start);
  });
  it("owner 不能领取轮次（/v1/agent/* 只给托管 Agent key）", async () => {
    const r = await call(env, "POST", "/v1/agent/claim", { worker: "w1" }, asOwner());
    expect(r.status).toBe(403);
    expect(r.json["error"]).toBe("agent_only");
  });
});
