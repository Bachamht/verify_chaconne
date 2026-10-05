/**
 * v7 Lane R · R-01：时间线分页无裁剪、每条有 actor、旧条目已回填（回填本身由 migration0025.test.ts 验证；这里验证写入路径）。
 *   - 每个写时间线的地方都经 appendTimeline：verify_task_timeline 有行且 actor 正确（owner / agent:byo / system）；
 *   - 超过 200 条：表里全量保留，timeline_json 兼容缓存只留最近 200 条且与表的最后 200 行一致；
 *   - 策略版本历史不再裁剪（旧实现 slice(-50)）。
 */
import { afterEach, describe, expect, it } from "vitest";
import { asc, eq } from "drizzle-orm";
import { verifyTaskTimeline, verifyTasks } from "@chaconne/db";
import { api, createTestEnv, type TestEnv } from "./helpers";
import { actorOf, appendTimeline, TIMELINE_CACHE_MAX } from "../src/records/timeline";
import { goalTaskBody, owner, WEB_KEY, webHeaders } from "./v7rHelpers";

let env: TestEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

async function rows(e: TestEnv, taskId: string) {
  return e.db.select().from(verifyTaskTimeline).where(eq(verifyTaskTimeline.taskId, taskId)).orderBy(asc(verifyTaskTimeline.id));
}

describe("R-01 · appendTimeline", () => {
  it("actorOf：web:<owner> → owner；agent:<钱包> → agent:byo；托管身份原样；内部 → system", () => {
    expect(actorOf(`web:${owner}`)).toBe("owner");
    expect(actorOf(`a2mcp:owner:${owner}`)).toBe("owner");
    expect(actorOf(`agent:${owner}`)).toBe("agent:byo");
    expect(actorOf("agent:hosted")).toBe("agent:hosted");
    expect(actorOf("executor:hosted")).toBe("executor:hosted");
    expect(actorOf(null)).toBe("system");
    expect(actorOf("system")).toBe("system");
    expect(actorOf("caller-alpha")).toBe("agent:byo");
  });

  it("建任务 / 改简报 / 暂停：每条都进表并带 actor；网页会话 = owner，配置 key = agent:byo", async () => {
    env = await createTestEnv({ extraKeys: `${WEB_KEY}:web:*` });
    const created = await api(env, "POST", "/v1/tasks", goalTaskBody(), webHeaders, WEB_KEY);
    expect(created.status, JSON.stringify(created.json).slice(0, 400)).toBe(201);
    const taskId = (created.json["task"] as { id: string }).id;
    const b = await api(env, "POST", `/v1/tasks/${taskId}/brief`, { strategy: "v2" }, webHeaders, WEB_KEY);
    expect(b.status, JSON.stringify(b.json).slice(0, 300)).toBe(200);
    const p = await api(env, "POST", `/v1/tasks/${taskId}/pause`, {}, webHeaders, WEB_KEY);
    expect(p.status, JSON.stringify(p.json).slice(0, 300)).toBe(200);
    const r = await rows(env, taskId);
    expect(r.length).toBeGreaterThanOrEqual(4);
    expect(r.every((x) => typeof x.actor === "string" && x.actor.length > 0)).toBe(true);
    const created0 = r.find((x) => x.type === "created")!;
    expect(created0.actor).toBe("owner");
    expect(r.find((x) => x.type === "brief_updated")!.actor).toBe("owner");
    const paused = r.find((x) => x.type === "status" && (x.dataJson as { to?: string }).to === "PAUSED")!;
    expect(paused.actor).toBe("owner");
    // 缓存与表一致（同序、同 type / at）
    const row = (await env.db.select().from(verifyTasks).where(eq(verifyTasks.id, taskId)))[0]!;
    const cache = row.timelineJson as Array<{ type: string; at: string }>;
    expect(cache.map((c) => c.type)).toEqual(r.map((x) => x.type));
    // 配置 key 调用方（自带 Agent）建的任务：agent:byo
    const viaKey = await api(env, "POST", "/v1/tasks", goalTaskBody());
    const r2 = await rows(env, (viaKey.json["task"] as { id: string }).id);
    expect(r2.find((x) => x.type === "created")!.actor).toBe("agent:byo");
  });

  it("超过 200 条：表里全量（不裁剪），缓存只留最近 200 条且等于表的最后 200 行；策略历史不裁剪", async () => {
    env = await createTestEnv({ extraKeys: `${WEB_KEY}:web:*` });
    const created = await api(env, "POST", "/v1/tasks", goalTaskBody(), webHeaders, WEB_KEY);
    const taskId = (created.json["task"] as { id: string }).id;
    const before = (await rows(env, taskId)).length;
    const base = Date.parse("2026-10-02T00:00:00.000Z");
    const entries = Array.from({ length: 230 }, (_, i) => ({ at: new Date(base + i * 1000).toISOString(), type: "probe", note: `n${i}`, data: { i } }));
    const res = await appendTimeline(env.db, taskId, entries, "system");
    expect(res.ids).toHaveLength(230);
    expect([...res.ids].sort((a, b) => a - b)).toEqual(res.ids);
    const all = await rows(env, taskId);
    expect(all.length).toBe(before + 230);
    const cache = (await env.db.select().from(verifyTasks).where(eq(verifyTasks.id, taskId)))[0]!.timelineJson as Array<{ type: string; note?: string }>;
    expect(cache.length).toBe(TIMELINE_CACHE_MAX);
    expect(cache.at(-1)!.note).toBe("n229");
    expect(cache.map((c) => c.note ?? c.type)).toEqual(all.slice(-TIMELINE_CACHE_MAX).map((x) => x.note ?? x.type));
    // 再追加：继续不裁剪
    await appendTimeline(env.db, taskId, { at: new Date(base + 999_000).toISOString(), type: "probe", note: "last" }, "agent:hosted");
    expect((await rows(env, taskId)).length).toBe(before + 231);
    expect((await rows(env, taskId)).at(-1)!.actor).toBe("agent:hosted");
    // 不存在的任务：不写孤儿行
    expect((await appendTimeline(env.db, "tsk_missing", { at: new Date().toISOString(), type: "x" }, "system")).ids).toEqual([]);
    // 策略版本历史：55 次修订全部保留
    for (let i = 0; i < 55; i++) await api(env, "POST", `/v1/tasks/${taskId}/brief`, { strategy: `s${i}` }, webHeaders, WEB_KEY);
    const v = await api(env, "GET", `/v1/tasks/${taskId}`, undefined, webHeaders, WEB_KEY);
    const hist = (v.json["task"] as { brief: { strategyHistory: Array<{ version: number }> } }).brief.strategyHistory;
    expect(hist.length).toBe(56);
    expect(hist.map((h) => h.version)).toEqual(Array.from({ length: 56 }, (_, i) => i + 1));
  });
});
