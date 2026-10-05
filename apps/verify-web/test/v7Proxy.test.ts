/**
 * P8 · 代理白名单：v7 的 O 路由全部放行；/v1/executor/*、/v1/agent/*、/v1/ops/* 一律不放行（服务身份与运营者只走服务内网）。
 * /activity 单列 120 次 / 分钟；owner 额度路由的路径地址走登录会话校验；v7 客户端函数打到正确路径。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ACTIVITY_LIMIT_PER_MIN, createRateLimiter, isActivityPath, ownerFromPath, proxyAllowed } from "../lib/proxyAllow";
import { normalizeChecklist, normalizePublicActivity, taskV7Extras, v7 } from "../lib/api-v2";

const A = "0xAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa";

describe("P8 · 代理白名单（interfaces §12.8 末条）", () => {
  it("§12.8 的全部 O 路由放行", () => {
    for (const p of [
      "v1/tasks/tsk_1/delegation", "v1/tasks/tsk_1/delegation/refresh", "v1/tasks/tsk_1/authorize", "v1/tasks/tsk_1/allowances",
      `v1/owners/${A}/allowances`, `v1/owners/${A}/allowances/reclaim`, `v1/owners/${A}/allowances/submit`,
      "v1/tasks/tsk_1/handover", "v1/tasks/tsk_1/activity", "v1/tasks/tsk_1/timeline", "v1/tasks/tsk_1/runs", "v1/tasks/tsk_1/runs/run_9",
      "v1/tasks/tsk_1/positions", "v1/tasks/tsk_1/agent-context", "v1/tasks/tsk_1/quotes", "v1/tasks/tsk_1/memory", "v1/tasks/tsk_1/share-activity",
    ]) expect(proxyAllowed(p), p).toBe(true);
  });
  it("旧名单原样保留", () => {
    for (const p of ["v1/assets", "healthz", "v1/tasks", "v1/tasks/tsk_1", "v1/tasks/tsk_1/intents/int_1/withdraw", `v1/portfolio/${A}`, "v1/keys/key_1", "v1/mandates/m_1/steps/0/submissions"]) expect(proxyAllowed(p), p).toBe(true);
  });
  it("/v1/executor/*、/v1/agent/*、/v1/ops/* 不放行（含各种绕法）", () => {
    for (const p of [
      "v1/executor/claim", "v1/executor/heartbeat", "v1/executor/jobs/exj_1/events", "v1/executor",
      "v1/agent/claim", "v1/agent/heartbeat", "v1/agent/runs/run_1/checkpoint", "v1/agent/runs/run_1/complete", "v1/agent",
      "v1/ops/faults", "v1/ops/status", "v1/ops",
      "v1/tasks/tsk_1/../../v1/ops/faults", "v1/tasks/tsk_1/activity/../../../v1/executor/claim", "v1/tasks/v1/agent/claim",
      "v1/owners/0x12/allowances", `v1/owners/${A}/allowances/reclaim/extra`, "v1/tasks/tsk_1/runs/run_1/steps", "v1/tasks/tsk_1/activityx",
    ]) expect(proxyAllowed(p), p).toBe(false);
  });
  it("route.ts 用 proxyAllowed 判定、不再自带名单；owner 额度路由的地址走会话校验", () => {
    const src = readFileSync(join(__dirname, "..", "app/api/verify/[...path]/route.ts"), "utf8");
    expect(src).toContain("proxyAllowed(joined)");
    expect(src).not.toMatch(/const ALLOWED = new RegExp/);
    expect(src).toContain("ownerFromPath(joined)");
    expect(ownerFromPath(`v1/owners/${A}/allowances/reclaim`)).toBe(A);
    expect(ownerFromPath(`v1/portfolio/${A}`)).toBe(A);
    expect(ownerFromPath("v1/tasks/tsk_1/activity")).toBeUndefined();
  });
  it("公开代理只多放行 tasks/:shareId/activity", () => {
    const src = readFileSync(join(__dirname, "..", "app/api/pub/[...path]/route.ts"), "utf8");
    const m = /const ALLOWED = (\/.*\/);/.exec(src);
    expect(m).toBeTruthy();
    const re = new RegExp(m![1]!.slice(1, -1));
    expect(re.test("tasks/shr_1/activity")).toBe(true);
    expect(re.test("reports/abc")).toBe(true);
    expect(re.test("tasks/shr_1/timeline")).toBe(false);
    expect(re.test("tasks/shr_1")).toBe(false);
  });
});

describe("P8 · /activity 单列限频", () => {
  it("只认 /v1/tasks/:id/activity", () => {
    expect(isActivityPath("v1/tasks/tsk_1/activity")).toBe(true);
    expect(isActivityPath("v1/tasks/tsk_1/timeline")).toBe(false);
  });
  it("每 owner 每分钟 120 次，第 121 次 429；窗口过后恢复；不同 owner 互不影响", () => {
    expect(ACTIVITY_LIMIT_PER_MIN).toBe(120);
    const rl = createRateLimiter(ACTIVITY_LIMIT_PER_MIN);
    const t0 = 1_000_000;
    for (let i = 0; i < 120; i++) expect(rl.hit("0xa", t0 + i).ok).toBe(true);
    const over = rl.hit("0xa", t0 + 500);
    expect(over.ok).toBe(false);
    expect(over.ok === false && over.retryAfterS).toBeGreaterThan(0);
    expect(rl.hit("0xb", t0 + 500).ok).toBe(true);
    expect(rl.hit("0xa", t0 + 60_000).ok).toBe(true);
  });
  it("3 s 轮询一小时也远在限额内（正常浏览不触发，P-04）", () => {
    const rl = createRateLimiter(ACTIVITY_LIMIT_PER_MIN);
    let blocked = 0;
    for (let t = 0; t < 3_600_000; t += 3_000) if (!rl.hit("0xa", t).ok) blocked++;
    expect(blocked).toBe(0);
  });
});

describe("P8 · v7 客户端函数", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });
  it("路径与方法按 §12.8；authorize 带 itemId 与每项固定的 clientRequestId", async () => {
    const seen: Array<{ url: string; method: string; body: unknown }> = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => { seen.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined }); return new Response("{}", { status: 200 }); }) as typeof fetch;
    await v7.delegation("tsk_1");
    await v7.authorizeItem("tsk_1", { itemId: "sell:eip155:196:0xabc", typedData: {}, signature: "0x01" });
    await v7.submitAllowance("tsk_1", { permitRequestId: "prm_1", signature: "0x02" });
    await v7.refreshDelegation("tsk_1");
    await v7.ownerAllowances(A);
    await v7.reclaim(A, "0xtoken");
    await v7.submitReclaim(A, { permitRequestId: "prm_2", signature: "0x03" });
    await v7.handover("tsk_1", { agent: "hosted", executor: "hosted" });
    await v7.activity("tsk_1", 41);
    await v7.timeline("tsk_1");
    await v7.runs("tsk_1");
    await v7.run("tsk_1", "run_1");
    await v7.positions("tsk_1");
    await v7.agentContext("tsk_1");
    await v7.quotes("tsk_1", [{ side: "buy", assetKey: "k", amountInRaw: "1" }]);
    await v7.memory("tsk_1");
    await v7.shareActivity("tsk_1");
    const lines = seen.map((s) => `${s.method} ${s.url}`);
    const a = A.toLowerCase();
    expect(lines).toEqual([
      "GET /api/verify/v1/tasks/tsk_1/delegation",
      "POST /api/verify/v1/tasks/tsk_1/authorize",
      "POST /api/verify/v1/tasks/tsk_1/allowances",
      "POST /api/verify/v1/tasks/tsk_1/delegation/refresh",
      `GET /api/verify/v1/owners/${a}/allowances`,
      `POST /api/verify/v1/owners/${a}/allowances/reclaim`,
      `POST /api/verify/v1/owners/${a}/allowances/submit`,
      "POST /api/verify/v1/tasks/tsk_1/handover",
      "GET /api/verify/v1/tasks/tsk_1/activity?since=41&limit=50",
      "GET /api/verify/v1/tasks/tsk_1/timeline?limit=100",
      "GET /api/verify/v1/tasks/tsk_1/runs",
      "GET /api/verify/v1/tasks/tsk_1/runs/run_1",
      "GET /api/verify/v1/tasks/tsk_1/positions",
      "GET /api/verify/v1/tasks/tsk_1/agent-context",
      "POST /api/verify/v1/tasks/tsk_1/quotes",
      "GET /api/verify/v1/tasks/tsk_1/memory",
      "POST /api/verify/v1/tasks/tsk_1/share-activity",
    ]);
    expect(seen[1]!.body).toMatchObject({ itemId: "sell:eip155:196:0xabc", clientRequestId: "tsk_1:auth:sell:eip155:196:0xabc" });
    expect(seen[2]!.body).toEqual({ permitRequestId: "prm_1", signature: "0x02" });
    // 每个 URL 都过代理白名单
    for (const s of seen) expect(proxyAllowed(s.url.replace("/api/verify/", "").split("?")[0]!), s.url).toBe(true);
  });
  it("归一化：清单缺字段给安全缺省；公开看板只留 at + category", () => {
    const c = normalizeChecklist({ delegation: { taskId: "t", items: [{ id: "buy" }] } }) as { items: unknown[]; counts: { signaturesNeeded: number }; complete: boolean };
    expect(c.items).toHaveLength(1);
    expect(c.counts.signaturesNeeded).toBe(0);
    expect(c.complete).toBe(false);
    const pub = normalizePublicActivity({ shareId: "s", items: [{ at: "2026-10-05T23:40:00Z", category: "intent_buy", amountRaw: "100", owner: A, note: "secret text" }] });
    expect(pub?.items).toEqual([{ at: "2026-10-05T23:40:00Z", category: "intent_buy" }]);
    expect(JSON.stringify(pub)).not.toMatch(/100|secret|0xAa/);
  });
  it("normalizeTask：v7 steps 拆成旧形状 steps + stepsV7（旧页面不再显示 undefined）", async () => {
    const { normalizeTask } = await import("../lib/api-v2");
    const n = normalizeTask({ task: { id: "t" }, steps: { buy: { planned: 5, confirmed: 2 }, sell: { confirmed: 1 } } }) as { steps: { planned: number; confirmed: number }; stepsV7: unknown };
    expect(n.steps).toEqual({ planned: 5, confirmed: 3, lastConfirmedAt: null });
    expect(taskV7Extras(n).stepsV7?.sell.confirmed).toBe(1);
    expect((normalizeTask({ task: { id: "t" }, steps: { planned: 2, confirmed: 1 } }) as { steps: unknown }).steps).toEqual({ planned: 2, confirmed: 1 });
  });
  it("taskV7Extras：v6 视图没有 runtime / v7 steps 时全为空；有就取出", () => {
    expect(taskV7Extras({ steps: { planned: 2, confirmed: 1 } })).toEqual({ runtime: null, delegation: null, positions: null, stepsV7: null });
    const x = taskV7Extras({ runtime: { agentMode: "hosted" }, steps: { buy: { planned: 5, confirmed: 2 }, sell: { confirmed: 1 } }, positions: [{ assetKey: "k" }] });
    expect(x.stepsV7?.buy.confirmed).toBe(2);
    expect(x.positions).toHaveLength(1);
  });
});
