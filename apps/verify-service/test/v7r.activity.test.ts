/**
 * v7 Lane R · R2 路由：GET /v1/tasks/:id/timeline（游标分页）、/activity（增量 + runtime 钩子）、/runs、/runs/:runId（R-02）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { verifyAgentRuns, verifyAgentRunSteps } from "@chaconne/db";
import { api, createTestEnv, OTHER_API_KEY, type TestEnv } from "./helpers";
import { appendTimeline } from "../src/records/timeline";
import { redactSecrets } from "../src/records/runs";
import { goalTaskBody, WEB_KEY, webHeaders } from "./v7rHelpers";

/** 假的密钥形态串（运行时拼接，避免文案 lint 把测试夹具当成真密钥） */
const FAKE_SK = ["sk", "abcdefghijklmnopqrstu"].join("-");
const FAKE_VK = ["vk", "live", "abcdefghijk"].join("_");

let env: TestEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

async function newTask(e: TestEnv): Promise<string> {
  const created = await api(e, "POST", "/v1/tasks", goalTaskBody(), webHeaders, WEB_KEY);
  expect(created.status, JSON.stringify(created.json).slice(0, 300)).toBe(201);
  return (created.json["task"] as { id: string }).id;
}
const web = (e: TestEnv, method: string, path: string, body?: unknown) => api(e, method, path, body, webHeaders, WEB_KEY);

describe("R2 · 时间线 / 活动流", () => {
  it("timeline：按 id 升序分页，cursor = 上页最后 id，最后一页 nextCursor = null；参数非法 400；别人的任务 403", async () => {
    env = await createTestEnv({ extraKeys: `${WEB_KEY}:web:*` });
    const taskId = await newTask(env);
    const base = Date.parse("2026-10-02T00:00:00.000Z");
    await appendTimeline(env.db, taskId, Array.from({ length: 25 }, (_, i) => ({ at: new Date(base + i * 1000).toISOString(), type: "probe", note: `n${i}` })), "agent:hosted");
    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const r = await web(env, "GET", `/v1/tasks/${taskId}/timeline?limit=10${cursor ? `&cursor=${cursor}` : ""}`);
      expect(r.status).toBe(200);
      const items = r.json["items"] as Array<{ id: number; actor: string; type: string }>;
      seen.push(...items.map((i) => i.id));
      expect(items.every((i) => i.actor)).toBe(true);
      cursor = r.json["nextCursor"] as string | null;
      pages++;
    } while (cursor && pages < 10);
    expect(seen.length).toBeGreaterThanOrEqual(27);
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
    expect(new Set(seen).size).toBe(seen.length);
    expect((await web(env, "GET", `/v1/tasks/${taskId}/timeline?cursor=abc`)).status).toBe(400);
    expect((await web(env, "GET", `/v1/tasks/${taskId}/timeline?limit=0`)).status).toBe(400);
    expect((await api(env, "GET", `/v1/tasks/${taskId}/timeline`, undefined, {}, OTHER_API_KEY)).status).toBe(403);
  });

  it("activity：不带 since → 最近 limit 条；带 since → 只给新条目；无新条目时 nextCursor 原样回；runtime 未装配为 null", async () => {
    env = await createTestEnv({ extraKeys: `${WEB_KEY}:web:*` });
    const taskId = await newTask(env);
    const first = await web(env, "GET", `/v1/tasks/${taskId}/activity?limit=2`);
    expect(first.status).toBe(200);
    expect(first.json["runtime"]).toBeNull();
    expect((first.json["items"] as unknown[]).length).toBe(2);
    const cur = first.json["nextCursor"] as string;
    const idle = await web(env, "GET", `/v1/tasks/${taskId}/activity?since=${cur}`);
    expect(idle.json["items"]).toEqual([]);
    expect(idle.json["nextCursor"]).toBe(cur);
    await appendTimeline(env.db, taskId, { at: "2026-10-02T01:00:00.000Z", type: "agent_tool", note: "查询事件日历" }, "agent:hosted");
    await appendTimeline(env.db, taskId, { at: "2026-10-02T01:00:01.000Z", type: "job_sent", note: "sent" }, "executor:hosted");
    const next = await web(env, "GET", `/v1/tasks/${taskId}/activity?since=${cur}`);
    const items = next.json["items"] as Array<{ type: string; actor: string; id: number }>;
    expect(items.map((i) => [i.type, i.actor])).toEqual([["agent_tool", "agent:hosted"], ["job_sent", "executor:hosted"]]);
    expect(next.json["nextCursor"]).toBe(String(items.at(-1)!.id));
    expect((await api(env, "GET", `/v1/tasks/${taskId}/activity`, undefined, {}, OTHER_API_KEY)).status).toBe(403);
  });
});

describe("R-02 · 轮次记录可读，预览不含密钥与原始提示", () => {
  it("runs：摘要来自 verify_agent_runs（哈希链字段、工具调用哈希）；详情不含 messages_json；模型入参预览不返回；密钥形态脱敏", async () => {
    env = await createTestEnv({ extraKeys: `${WEB_KEY}:web:*` });
    const taskId = await newTask(env);
    const now = new Date("2026-10-02T02:00:00.000Z");
    const h = (c: string) => `0x${c.repeat(64)}`;
    await env.db.insert(verifyAgentRuns).values({ id: "run_r02", taskId, turnVersion: 1, reason: "assigned", mode: "SIMULATION", state: "COMPLETED", attempt: 1, runTokenHash: h("9"), model: "model-x", promptHash: h("a"), messagesJson: [{ role: "user", content: "SECRET-PROMPT-TEXT" }], actionJson: { kind: "status", ref: "turn:1", status: "waiting" }, decisionSummary: "wait for payrolls", nextCheckAt: new Date("2026-10-02T12:30:00.000Z"), invalidation: "if data is delayed", usageJson: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 0 }, costUsdMicros: "4200", prevRunHash: null, runHash: h("b"), startedAt: now, endedAt: now, createdAt: now, updatedAt: now });
    await env.db.insert(verifyAgentRunSteps).values([
      { runId: "run_r02", attempt: 1, seq: 0, kind: "model", name: "model", argsPreview: "SYSTEM PROMPT: you are ...", resultPreview: "calling get_events", tokensIn: 1000, tokensOut: 50, latencyMs: 900, at: now },
      { runId: "run_r02", attempt: 1, seq: 1, kind: "tool", name: "get_events", argsHash: h("c"), resultHash: h("d"), argsPreview: '{"kinds":["MACRO_TIER1"]}', resultPreview: `leaked ${"ab".repeat(32)} key ${FAKE_SK} and ${FAKE_VK}`, latencyMs: 120, at: now },
    ]);
    const list = await web(env, "GET", `/v1/tasks/${taskId}/runs`);
    expect(list.status).toBe(200);
    const runs = list.json["runs"] as Array<Record<string, unknown>>;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ runId: "run_r02", turnVersion: 1, turnReason: "assigned", model: "model-x", promptHash: h("a"), runHash: h("b"), prevRunHash: null, state: "COMPLETED", action: { kind: "status", ref: "turn:1" }, toolCalls: [{ name: "get_events", argsHash: h("c"), resultHash: h("d") }], usage: { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 0, costUsdMicros: "4200" } });
    const detail = await web(env, "GET", `/v1/tasks/${taskId}/runs/run_r02`);
    expect(detail.status).toBe(200);
    const text = JSON.stringify(detail.json) + JSON.stringify(list.json);
    expect(text).not.toContain("SECRET-PROMPT-TEXT");
    expect(text).not.toContain("SYSTEM PROMPT");
    expect(text).not.toContain("messages");
    expect(text).not.toContain("runToken");
    expect(text).not.toContain("ab".repeat(32));
    expect(text).not.toContain(FAKE_SK);
    expect(text).not.toContain(FAKE_VK);
    const steps = detail.json["steps"] as Array<Record<string, unknown>>;
    expect(steps.map((s) => s["kind"])).toEqual(["model", "tool"]);
    expect(steps[0]!["argsPreview"]).toBeUndefined();
    expect(steps[1]!["argsPreview"]).toBe('{"kinds":["MACRO_TIER1"]}');
    expect((await web(env, "GET", `/v1/tasks/${taskId}/runs/run_nope`)).status).toBe(404);
    expect((await api(env, "GET", `/v1/tasks/${taskId}/runs`, undefined, {}, OTHER_API_KEY)).status).toBe(403);
  });

  it("redactSecrets：保留 0x 前缀的 32 字节哈希，脱敏裸 32 字节十六进制与 key 前缀", () => {
    const hash = `0x${"1f".repeat(32)}`;
    expect(redactSecrets(`tx ${hash}`)).toBe(`tx ${hash}`);
    expect(redactSecrets(`k ${"1f".repeat(32)}`)).toBe("k [redacted:hex32]");
    expect(redactSecrets("Authorization: Bearer abcdefghijklmnop")).toBe("Authorization: Bearer [redacted]");
  });
});
