/**
 * v7 Lane A · 托管 Agent 运行时（集成：pglite + fixture 证据）：
 *  A-01 续跑不重做已完成工具；A-02 终结动作 clientRequestId 幂等；A-04 日上限不领新轮次并标 agent_budget_exhausted；
 *  A-08 nextCheckAt → scheduled 轮次；A-10 观察模式同一循环、SIMULATION 不签证书；A-11 任务记忆；A-12 presence（集成）；
 *  A-14 成本记账与价格缺失；A-17 轮次绑定；A-18 ended；CV-D23 任务证据被分拣承认；quotes 限制；data_arrived 钩子。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { verifyAgentRunSteps, verifyAgentRuns, verifyTaskIntents, verifyTaskEvidence, verifyTasks } from "@chaconne/db";
import type { AgentTurn } from "@chaconne/core/verify";
import { verifyRunChain } from "@chaconne/core/verify/agent/index";
import { agentRunHash } from "@chaconne/core/verify";
import { listRunSummaries as listRecordSummaries } from "../src/records/runs";
import { agentNeedsOwner, agentPresenceFor } from "../src/tasks/runtime";
import { asAgent, asOwner, call, claimFor, createV7AEnv, hostedTask, STOCK, type V7AEnv } from "./v7a.helpers";

const H = (c: string) => `0x${c.repeat(64)}`;
let env: V7AEnv;
beforeAll(async () => {
  env = await createV7AEnv();
});
afterAll(async () => {
  await env?.close();
});

const turnOf = async (id: string) => (await env.tasks.byId(id))!.agentTurnJson as AgentTurn;
const status = (token: string, taskId: string, body: Record<string, unknown>) => call(env, "POST", `/v1/tasks/${taskId}/agent-status`, body, asAgent(token));
const complete = (token: string, runId: string, body: Record<string, unknown>) => call(env, "POST", `/v1/agent/runs/${runId}/complete`, body, asAgent(token));

describe("A-17 轮次绑定 / A-02 幂等 / 哈希链", () => {
  it("第 v 轮进行中开出 v+1：v 的动作只关闭 v、v+1 保持打开；同轮第二个终结动作 409 并带回已记录动作；同 clientRequestId 重放不重复", async () => {
    const t = await hostedTask(env, "bind-1");
    const run = await claimFor(env, t);
    await env.tasks.openAgentTurn(t, "scheduled", "newer turn", "sched:x");
    const v1 = (await turnOf(t)).version;
    expect(v1).toBe(run.turnVersion + 1);
    const r = await status(run.runToken, t, { status: "declined", note: "spread too wide", clientRequestId: `h:${run.runId}:1`, nextCheckAt: new Date(Date.parse(env.cfgNow()) + 3600_000).toISOString(), invalidation: "a tighter spread" });
    expect(r.status).toBe(200);
    const after = await turnOf(t);
    expect(after.version).toBe(v1);
    expect(after.state).toBe("awaiting_agent");
    const again = await status(run.runToken, t, { status: "declined", note: "spread too wide", clientRequestId: `h:${run.runId}:1` });
    expect(again.status).toBe(200);
    const second = await status(run.runToken, t, { status: "needs_evidence", note: "want more", clientRequestId: `h:${run.runId}:2` });
    expect(second.status).toBe(409);
    expect(second.json["error"]).toBe("turn_already_answered");
    expect((second.json["details"] as { recordedAction: { status: string } }).recordedAction.status).toBe("declined");
    const intent = await call(env, "POST", `/v1/tasks/${t}/intents`, { clientRequestId: `h:${run.runId}:3`, outputAssetKey: STOCK, amountInRaw: "1000000", decision: { rationale: "x", claims: [] } }, asAgent(run.runToken));
    expect(intent.status).toBe(409);
    const mismatch = await status(run.runToken, t, { status: "declined", note: "x", clientRequestId: `h:${run.runId}:4`, turnVersion: v1 });
    expect(mismatch.status).toBe(409);
    expect(mismatch.json["error"]).toBe("turn_version_mismatch");
    // nextCheckAt 存进任务
    expect((await env.tasks.byId(t))!.nextAgentCheckAt).not.toBeNull();
  });

  it("A-02：托管 Agent 的意图同 clientRequestId 重放 → 同一条意图，不产生第二条", async () => {
    const t = await hostedTask(env, "idem-1");
    const run = await claimFor(env, t);
    const body = { clientRequestId: `h:${run.runId}:1`, outputAssetKey: STOCK, amountInRaw: "1000000", decision: { rationale: "regular session, small size", claims: [] } };
    const a = await call(env, "POST", `/v1/tasks/${t}/intents`, body, asAgent(run.runToken));
    expect([201, 422]).toContain(a.status);
    const b = await call(env, "POST", `/v1/tasks/${t}/intents`, body, asAgent(run.runToken));
    expect(b.status).toBe(200);
    expect((b.json["intent"] as { id: string }).id).toBe((a.json["intent"] as { id: string }).id);
    expect((await env.db.select().from(verifyTaskIntents).where(eq(verifyTaskIntents.taskId, t))).length).toBe(1);
    const row = (await env.db.select().from(verifyTaskIntents).where(eq(verifyTaskIntents.taskId, t)))[0]!;
    expect(row.turnVersion).toBe(run.turnVersion);
    // A-10：SIMULATION 不签证书
    expect(row.stepJson).toBeNull();
  });

  it("complete：没有终结动作 → 409；有 → runHash 链（第二轮 prev = 第一轮），离线复算通过；成本按价格变量记账（A-14）", async () => {
    const t = await hostedTask(env, "chain-1");
    const r1 = await claimFor(env, t);
    const noAction = await complete(r1.runToken, r1.runId, { attempt: r1.attempt, state: "COMPLETED", model: "m-test", promptHash: H("a") });
    expect(noAction.status).toBe(409);
    expect(noAction.json["error"]).toBe("no_terminal_action");
    const cp = await call(env, "POST", `/v1/agent/runs/${r1.runId}/checkpoint`, { attempt: r1.attempt, steps: [{ seq: 0, kind: "model", tokensIn: 100, tokensOut: 20, latencyMs: 5 }, { seq: 1, kind: "tool", name: "get_turn_context", argsHash: H("b"), resultHash: H("c"), argsPreview: { taskId: t, apiKey: "sk-should-not-appear-0123456789" }, latencyMs: 9 }], usage: { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 10000 } }, asAgent(r1.runToken));
    expect(cp.status).toBe(200);
    expect((await status(r1.runToken, t, { status: "declined", note: "wait for data", clientRequestId: `h:${r1.runId}:2` })).status).toBe(200);
    const c1 = await complete(r1.runToken, r1.runId, { attempt: r1.attempt, state: "COMPLETED", model: "m-test", promptHash: H("a"), decisionSummary: "waiting for the payrolls print", nextCheckAt: new Date(Date.parse(env.cfgNow()) + 3600_000).toISOString() });
    expect(c1.status).toBe(200);
    expect(c1.json["usage"]).toMatchObject({ costUsdMicros: "9000" });
    expect(c1.json["prevRunHash"]).toBeNull();
    expect(c1.json["toolCalls"]).toEqual([{ name: "get_turn_context", argsHash: H("b"), resultHash: H("c") }]);
    const after = await call(env, "GET", `/v1/tasks/${t}/agent-context`, undefined, asAgent(r1.runToken));
    expect(after.status).toBe(409); // 令牌随 complete 失效
    env.setNow(new Date(Date.parse(env.cfgNow()) + 1000).toISOString());
    const r2 = await claimFor(env, t, "data_arrived");
    expect((await status(r2.runToken, t, { status: "needs_evidence", note: "need the print", clientRequestId: `h:${r2.runId}:1` })).status).toBe(200);
    const c2 = await complete(r2.runToken, r2.runId, { attempt: r2.attempt, state: "INCOMPLETE", model: "m-test", promptHash: H("a") });
    expect(c2.json["prevRunHash"]).toBe(c1.json["runHash"]);
    const chain = (await env.runtime.listRunSummaries(t)).filter((r) => r.runHash !== H("0")).reverse();
    expect(verifyRunChain(chain).ok).toBe(true);
    expect(verifyRunChain([{ ...chain[0]!, decisionSummary: "tampered" }, chain[1]!]).ok).toBe(false);
    // 证据包 v3 / GET /runs 用的是 Lane R 的 listRunSummaries：同一口径（action 只有 kind/ref/status、toolCalls 同一筛选）→ 每轮 runHash 可复算、usage 读 total（e2e 分叉上发现 run_hash_chain 复算不过）
    const viaRecords = await listRecordSummaries(env.db, t);
    for (const r of viaRecords.filter((x) => x.runHash !== H("0"))) {
      expect(r.action && Object.keys(r.action).sort()).toEqual(["kind", "ref", "status"]);
      expect(agentRunHash(r)).toBe(r.runHash);
    }
    expect(viaRecords.find((r) => r.runId === r1.runId)!.usage).toMatchObject({ inputTokens: 1000, outputTokens: 200, cacheReadTokens: 10000 });
    // 预览里的密钥被服务端遮掉（SEC-05）
    const steps = await env.db.select().from(verifyAgentRunSteps).where(eq(verifyAgentRunSteps.runId, r1.runId));
    const pv = steps.find((s) => s.seq === 1)!.argsPreview!;
    expect(pv).toContain(t);
    expect(pv).not.toContain("sk-should-not-appear");
  });
});

describe("A-18 ended", () => {
  it("任务转 PAUSED（paused_by=agent）、不再开轮次、needsOwner: agent_ended、presence=ended；不走 owner 的 transition", async () => {
    const t = await hostedTask(env, "ended-1");
    const run = await claimFor(env, t);
    const r = await status(run.runToken, t, { status: "ended", note: "goal reached", clientRequestId: `h:${run.runId}:1` });
    expect(r.status).toBe(200);
    const row = (await env.tasks.byId(t))!;
    expect(row.status).toBe("PAUSED");
    expect(row.pausedBy).toBe("agent");
    expect((row.timelineJson as Array<{ note?: string }>).some((e) => /agent's ended report/.test(e.note ?? ""))).toBe(true);
    expect((row.timelineJson as Array<{ note?: string }>).some((e) => /paused by owner/.test(e.note ?? ""))).toBe(false);
    expect(await env.tasks.openAgentTurn(t, "scheduled", "x", "sched:after-end")).toBeNull();
    expect(agentNeedsOwner(row).map((n) => n.code)).toEqual(["agent_ended"]);
    const p = await agentPresenceFor(env.db, row, { owner: agentNeedsOwner(row), operator: [] });
    expect(p).toMatchObject({ mode: "hosted", state: "ended" });
    // owner 恢复 → paused_by 清空
    const resumed = await call(env, "POST", `/v1/tasks/${t}/resume`, {}, asOwner());
    expect(resumed.status).toBe(200);
    expect((await env.tasks.byId(t))!.pausedBy).toBeNull();
  });
});

describe("A-01 续跑", () => {
  it("租约过期后另一 worker 领到同一轮次：attempt+1，带回 messages 与已完成工具；已完成工具不重做；旧 attempt 的 checkpoint 409", async () => {
    const t = await hostedTask(env, "resume-1");
    const run = await claimFor(env, t);
    const messages = [{ role: "user", content: [{ type: "text", text: "context" }] }, { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "get_executable_quotes", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "{}" }] }];
    await call(env, "POST", `/v1/agent/runs/${run.runId}/checkpoint`, { attempt: 1, steps: [{ seq: 1, kind: "tool", name: "get_executable_quotes", argsHash: H("d"), resultHash: H("e"), latencyMs: 3 }], messages }, asAgent(run.runToken));
    const start = env.cfgNow();
    env.setNow(new Date(Date.parse(start) + 250_000).toISOString());
    const claim = await call(env, "POST", "/v1/agent/claim", { worker: "w2", max: 5 }, asAgent());
    const r2 = (claim.json["runs"] as Array<{ taskId: string; attempt: number; runToken: string; runId: string; resume?: { messages: unknown[]; completedTools: Array<{ name: string }> } }>).find((x) => x.taskId === t)!;
    expect(r2.runId).toBe(run.runId);
    expect(r2.attempt).toBe(2);
    expect(r2.resume?.messages).toEqual(messages);
    expect(r2.resume?.completedTools.map((x) => x.name)).toEqual(["get_executable_quotes"]);
    const stale = await call(env, "POST", `/v1/agent/runs/${run.runId}/checkpoint`, { attempt: 1, steps: [] }, asAgent(r2.runToken));
    expect(stale.status).toBe(409);
    expect(stale.json["error"]).toBe("stale_attempt");
    env.setNow(start);
  });
});

describe("A-04 / A-14 成本与上限", () => {
  it("任务日上限：今日成本 ≥ 上限 → 不领新轮次，needsOperator 含 agent_budget_exhausted，运营者收到告警", async () => {
    const t = await hostedTask(env, "cap-1");
    const r = await claimFor(env, t);
    await env.db.update(verifyAgentRuns).set({ costUsdMicros: "2000000", state: "COMPLETED", actionJson: { kind: "status", ref: "x", status: "declined", clientRequestId: null }, leaseUntil: null }).where(eq(verifyAgentRuns.id, r.runId));
    await env.tasks.openAgentTurn(t, "scheduled", "again", "sched:cap");
    const c = await call(env, "POST", "/v1/agent/claim", { worker: "w1", max: 5 }, asAgent());
    const runs = c.status === 200 ? (c.json["runs"] as Array<{ taskId: string }>) : [];
    expect(runs.some((x) => x.taskId === t)).toBe(false);
    expect(await env.runtime.needsOperatorFor(t)).toContain("agent_budget_exhausted");
    expect(env.notify.operatorAlerts.some((a) => a.code === "agent_budget_exhausted")).toBe(true);
  });
  it("价格变量缺失 → 托管 Agent 不启用（claim 503）并告警", async () => {
    const e2 = await createV7AEnv({ prices: false });
    try {
      const r = await call(e2, "POST", "/v1/agent/claim", { worker: "w1" }, asAgent());
      expect(r.status).toBe(503);
      expect(r.json["error"]).toBe("hosted_disabled");
      expect(e2.runtime.enabled).toBe(false);
    } finally {
      await e2.close();
    }
  });
  it("开关关闭：/v1/agent/* 与 agent-context 503，服务 key 的任务请求同样 503", async () => {
    const e3 = await createV7AEnv({ hostedAgent: false });
    try {
      expect((await call(e3, "POST", "/v1/agent/claim", { worker: "w1" }, asAgent())).status).toBe(503);
      expect((await call(e3, "GET", "/v1/tasks/tsk_x/agent-context", undefined, asOwner())).status).toBe(503);
    } finally {
      await e3.close();
    }
  });
});

describe("A-08 scheduled / data_arrived 钩子", () => {
  it("状态报告的 nextCheckAt 到点 → scheduledTick 开 scheduled 轮次（同一时刻不重复开）", async () => {
    const t = await hostedTask(env, "sched-1");
    const run = await claimFor(env, t);
    const at = new Date(Date.parse(env.cfgNow()) + 600_000).toISOString();
    await status(run.runToken, t, { status: "declined", note: "later", clientRequestId: `h:${run.runId}:1`, nextCheckAt: at, invalidation: "price drops 2%" });
    expect(await env.runtime.scheduledTick()).not.toContain(t);
    const start = env.cfgNow();
    env.setNow(new Date(Date.parse(at) + 1000).toISOString());
    expect(await env.runtime.scheduledTick()).toContain(t);
    const turn = await turnOf(t);
    expect(turn.reason).toBe("scheduled");
    expect(turn.triggerKey).toBe(`sched:${at}`);
    expect(await env.runtime.scheduledTick()).not.toContain(t);
    env.setNow(start);
  });
  it("实际值入库（Lane D 回调）→ 关注该类事件的托管任务开 data_arrived 轮次；修订 → event 轮次", async () => {
    const t = await hostedTask(env, "data-1");
    const hooks: { onDataArrived?: (id: string, info: { revision: number; outcomeRevision: number }) => Promise<void>; onOutcomeRevised?: (id: string, info: { revision: number; outcomeRevision: number }) => Promise<void> } = {};
    env.runtime.attachOutcomeHooks({ set: (h) => Object.assign(hooks, h) }, async (id) => ({ id, kind: "MACRO_TIER1", name: "US payrolls", revision: 2, underlyingIds: [] }));
    await hooks.onDataArrived!("evt-nfp", { revision: 2, outcomeRevision: 0 });
    let turn = await turnOf(t);
    expect(turn.reason).toBe("data_arrived");
    expect(turn.triggerKey).toBe("data:evt-nfp@2");
    await hooks.onOutcomeRevised!("evt-nfp", { revision: 3, outcomeRevision: 1 });
    turn = await turnOf(t);
    expect(turn.reason).toBe("event");
  });
});

describe("决策上下文 / CV-D23 / quotes / 记忆", () => {
  it("agent-context 形状；证据写进 verify_task_evidence；意图引用它 → platform_verified（via task_evidence）", async () => {
    const t = await hostedTask(env, "ctx-1");
    const run = await claimFor(env, t);
    const ctx = await call(env, "GET", `/v1/tasks/${t}/agent-context`, undefined, asAgent(run.runToken));
    expect(ctx.status).toBe(200);
    for (const k of ["now", "session", "task", "turn", "run", "budget", "positions", "lastIntent", "recentRuns", "memory", "thesis", "events", "evidence"]) expect(ctx.json).toHaveProperty(k);
    expect((ctx.json["task"] as { scope: { perStepCapRaw: string } }).scope.perStepCapRaw).toBe("10000000");
    const q = await call(env, "POST", `/v1/tasks/${t}/quotes`, { items: [{ side: "buy", assetKey: STOCK, amountInRaw: "5000000" }] }, asAgent(run.runToken));
    expect(q.status).toBe(200);
    const item = (q.json["items"] as Array<Record<string, unknown>>)[0]!;
    expect(item["cached"]).toBe(false);
    const evId = (item["evidenceIds"] as string[])[0]!;
    expect((await env.db.select().from(verifyTaskEvidence).where(eq(verifyTaskEvidence.taskId, t))).some((r) => r.evidenceId === evId && r.source === "quotes")).toBe(true);
    const cachedQ = await call(env, "POST", `/v1/tasks/${t}/quotes`, { items: [{ side: "buy", assetKey: STOCK, amountInRaw: "5000000" }] }, asAgent(run.runToken));
    expect((cachedQ.json["items"] as Array<Record<string, unknown>>)[0]!["cached"]).toBe(true);
    const it = await call(env, "POST", `/v1/tasks/${t}/intents`, { clientRequestId: `h:${run.runId}:5`, outputAssetKey: STOCK, amountInRaw: "5000000", decision: { rationale: "quoted price ok", claims: [{ kind: "platform_fact", text: "executable quote I just fetched", source: { evidenceId: evId } }] } }, asAgent(run.runToken));
    expect([201, 422]).toContain(it.status);
    const triage = (it.json["intent"] as { triage: Array<{ label: string; via?: string }> }).triage;
    expect(triage[0]).toMatchObject({ label: "platform_verified" });
  });
  it("quotes：超出每笔上限 / 不在范围 → 400；每任务每小时 ≤ 20 次上游取价 → 429", async () => {
    const t = await hostedTask(env, "quote-1");
    expect((await call(env, "POST", `/v1/tasks/${t}/quotes`, { items: [{ side: "buy", assetKey: STOCK, amountInRaw: "10000001" }] }, asOwner())).status).toBe(400);
    expect((await call(env, "POST", `/v1/tasks/${t}/quotes`, { items: [{ side: "buy", assetKey: "eip155:196:0x1111111111111111111111111111111111111111", amountInRaw: "1" }] }, asOwner())).status).toBe(400);
    expect((await call(env, "POST", `/v1/tasks/${t}/quotes`, { items: [{ side: "sell", assetKey: STOCK, amountInRaw: "1" }] }, asOwner())).status).toBe(400);
    let last = 0;
    for (let i = 1; i <= 21; i++) last = (await call(env, "POST", `/v1/tasks/${t}/quotes`, { items: [{ side: "buy", assetKey: STOCK, amountInRaw: String(1000 + i) }] }, asOwner())).status;
    expect(last).toBe(429);
  });
  it("A-11 记忆：≤ 20 条先进先出；clientRequestId 去重；跨轮在上下文里可见", async () => {
    const t = await hostedTask(env, "mem-1");
    for (let i = 0; i < 22; i++) {
      const r = await call(env, "POST", `/v1/tasks/${t}/memory`, { text: `note ${i}`, clientRequestId: `m${i}` }, asOwner());
      expect(r.status).toBe(201);
    }
    const dup = await call(env, "POST", `/v1/tasks/${t}/memory`, { text: "note 21 again", clientRequestId: "m21" }, asOwner());
    expect(dup.status).toBe(200);
    expect(dup.json["duplicate"]).toBe(true);
    const list = await call(env, "GET", `/v1/tasks/${t}/memory`, undefined, asOwner());
    const notes = list.json["notes"] as Array<{ text: string }>;
    expect(notes.length).toBe(20);
    expect(notes[0]!.text).toBe("note 2");
    const run = await claimFor(env, t);
    const ctx = await call(env, "GET", `/v1/tasks/${t}/agent-context`, undefined, asAgent(run.runToken));
    expect((ctx.json["memory"] as unknown[]).length).toBe(20);
  });
  it("A-12 presence（集成）：领取后 working（当前活动 = 最近工具）；完成后 waiting；未托管 = unassigned", async () => {
    const t = await hostedTask(env, "pres-1");
    const run = await claimFor(env, t);
    await call(env, "POST", `/v1/agent/runs/${run.runId}/checkpoint`, { attempt: 1, steps: [{ seq: 1, kind: "tool", name: "get_executable_quotes", argsHash: H("1"), resultHash: H("2"), latencyMs: 1 }] }, asAgent(run.runToken));
    let row = (await env.tasks.byId(t))!;
    expect(await agentPresenceFor(env.db, row, { owner: [], operator: [] }, undefined, Date.parse(env.cfgNow()))).toMatchObject({ state: "working", currentActivity: "checking executable quotes" });
    await status(run.runToken, t, { status: "declined", note: "x", clientRequestId: `h:${run.runId}:2` });
    await complete(run.runToken, run.runId, { attempt: 1, state: "COMPLETED", model: "m", promptHash: H("a") });
    row = (await env.tasks.byId(t))!;
    expect((await agentPresenceFor(env.db, row, { owner: [], operator: [] }, undefined, Date.parse(env.cfgNow()))).state).toBe("waiting");
    await env.db.update(verifyTasks).set({ agentMode: null }).where(eq(verifyTasks.id, t));
    expect(await agentPresenceFor(env.db, (await env.tasks.byId(t))!, { owner: [], operator: [] }, undefined, Date.parse(env.cfgNow()))).toEqual({ mode: "none", state: "unassigned" });
  });
});

describe("10/3 线上回归：complete 413、declined 缺 nextCheckAt、卡死的 RUNNING", () => {
  it("complete 带超过 64kb 的对话全文不再被 413 拒；轮次收尾为 COMPLETED", async () => {
    const t = await hostedTask(env, "big-1");
    const run = await claimFor(env, t);
    await status(run.runToken, t, { status: "declined", note: "wait", clientRequestId: `h:${run.runId}:1`, nextCheckAt: new Date(Date.parse(env.cfgNow()) + 600_000).toISOString() });
    const messages = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: "x".repeat(4000) }));
    const r = await complete(run.runToken, run.runId, { attempt: 1, state: "COMPLETED", model: "m", promptHash: H("a"), messages });
    expect(r.status).toBe(200);
    const [row] = await env.db.select().from(verifyAgentRuns).where(eq(verifyAgentRuns.id, run.runId));
    expect(row!.state).toBe("COMPLETED");
  });
  it("declined 没带 nextCheckAt → 缺省 15 分钟后复查（到点 scheduledTick 会叫醒），不超过授权期限", async () => {
    const t = await hostedTask(env, "nonext-1");
    const run = await claimFor(env, t);
    const before = Date.parse(env.cfgNow());
    const res = await status(run.runToken, t, { status: "declined", note: "weekend, data stale", clientRequestId: `h:${run.runId}:1` });
    expect(res.status).toBeLessThan(300);
    const row = (await env.tasks.byId(t))!;
    expect(row.nextAgentCheckAt).not.toBeNull();
    expect(row.nextAgentCheckAt!.getTime() - before).toBe(15 * 60_000);
    const start = env.cfgNow();
    env.setNow(new Date(row.nextAgentCheckAt!.getTime() + 1000).toISOString());
    expect(await env.runtime.scheduledTick()).toContain(t);
    env.setNow(start);
  });
  it("轮次已回答但 complete 没落库、租约过期：presence 不再是 working（上次决策 = 回答时刻）；下一次 claim 前收尾为 INCOMPLETE", async () => {
    const t = await hostedTask(env, "stuck-1");
    const run = await claimFor(env, t);
    await call(env, "POST", `/v1/agent/runs/${run.runId}/checkpoint`, { attempt: 1, steps: [{ seq: 1, kind: "tool", name: "get_executable_quotes", argsHash: H("1"), resultHash: H("2"), latencyMs: 1 }] }, asAgent(run.runToken));
    await status(run.runToken, t, { status: "declined", note: "x", clientRequestId: `h:${run.runId}:2`, nextCheckAt: new Date(Date.parse(env.cfgNow()) + 3_600_000).toISOString() });
    // 不调 complete（模拟 413）；租约过期
    const start = env.cfgNow();
    env.setNow(new Date(Date.parse(start) + 300_000).toISOString());
    const p = await agentPresenceFor(env.db, (await env.tasks.byId(t))!, { owner: [], operator: [] }, undefined, Date.parse(env.cfgNow()));
    expect(p).toMatchObject({ state: "waiting" });
    expect((p as { lastDecisionAt?: string | null }).lastDecisionAt).toBeTruthy();
    await call(env, "POST", "/v1/agent/claim", { worker: "w-sweep", max: 1 }, asAgent());
    const [row] = await env.db.select().from(verifyAgentRuns).where(eq(verifyAgentRuns.id, run.runId));
    expect(row!.state).toBe("INCOMPLETE");
    expect(row!.endedAt).not.toBeNull();
    env.setNow(start);
  });
});
