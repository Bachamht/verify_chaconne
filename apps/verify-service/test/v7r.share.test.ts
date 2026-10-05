/**
 * v7 Lane R · R5：公开值守看板。
 *   R-06 / P-07：公开输出只有 类别 + 时间 + 操作者类别——没有任何金额、数量、地址、id 或自由文本；默认公开、可关；私密 → 404；
 *   服务端缓存 5 s；别人的任务不能开分享。
 */
import { afterEach, describe, expect, it } from "vitest";
import { api, createTestEnv, OTHER_API_KEY, type TestEnv } from "./helpers";
import { appendTimeline } from "../src/records/timeline";
import { ACTIVITY_CATEGORIES } from "../src/records/activity";
import { resetPublicActivityCache } from "../src/records/share";
import { goalTaskBody, owner, WEB_KEYS, WEB_KEY, webHeaders } from "./v7rHelpers";

let env: TestEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
  resetPublicActivityCache();
});

const T0 = "2026-09-18T15:00:00.000Z";
const web = (e: TestEnv, method: string, path: string, body?: unknown) => api(e, method, path, body, webHeaders, WEB_KEY);
const pub = (e: TestEnv, path: string) => fetch(e.url + path).then(async (r) => ({ status: r.status, cache: r.headers.get("cache-control"), text: await r.text() }));

describe("R-06 / P-07 · 公开值守看板只有类别与时间", () => {
  it("分享 → 公开读取只含 {at, category, actor}；金额 / 数量 / 地址 / id / 自由文本一律不出；关闭后 404", async () => {
    env = await createTestEnv({ extraKeys: WEB_KEYS, now: T0 });
    const created = await web(env, "POST", "/v1/tasks", goalTaskBody());
    const taskId = (created.json["task"] as { id: string }).id;
    const SECRET_NOTE = "bought 123456789 AAPLx for 0.5 USDG at 0xabcdefabcdefabcdefabcdefabcdefabcdefabcd";
    await appendTimeline(env.db, taskId, [
      { at: "2026-09-18T15:01:00.000Z", type: "intent_certified", ref: "int_deadbeef", note: SECRET_NOTE, data: { amountInRaw: "50000000", owner } },
      { at: "2026-09-18T15:02:00.000Z", type: "step_confirmed", ref: "mnd_cafe:0", note: "spent 50000000", data: { spentRaw: "50000000", receivedRaw: "250000000000000000" } },
      { at: "2026-09-18T15:03:00.000Z", type: "job_sent", note: `tx 0x${"ab".repeat(32)}` },
      { at: "2026-09-18T15:04:00.000Z", type: "agent_needs_evidence", note: "wants payrolls 254k vs 140k" },
      { at: "2026-09-18T15:05:00.000Z", type: "recertified", note: "new cert" },
      { at: "2026-09-18T15:06:00.000Z", type: "some_future_type", note: "free text 42" },
    ], "agent:hosted");

    // 别人不能开分享
    expect((await api(env, "POST", `/v1/tasks/${taskId}/share-activity`, {}, {}, OTHER_API_KEY)).status).toBe(403);
    expect((await web(env, "POST", `/v1/tasks/${taskId}/share-activity`, { public: "yes" })).status).toBe(400);
    const s = await web(env, "POST", `/v1/tasks/${taskId}/share-activity`, {});
    expect(s.status, JSON.stringify(s.json)).toBe(201);
    const shareId = s.json["shareId"] as string;
    expect(s.json).toMatchObject({ public: true, publicUrl: `/pub/tasks/${shareId}/activity`, privacy: { hideOwner: true, hideAssets: true, hideAmounts: true, categoriesOnly: true } });
    // 幂等：同一任务同一 shareId
    expect((await web(env, "POST", `/v1/tasks/${taskId}/share-activity`, {})).json["shareId"]).toBe(shareId);

    const r = await pub(env, `/pub/tasks/${shareId}/activity`);
    expect(r.status).toBe(200);
    expect(r.cache).toBe("public, max-age=5");
    const body = JSON.parse(r.text) as { items: Array<Record<string, unknown>>; counts: Record<string, number>; kind: string; generatedAt: string; shareId: string; privacy: Record<string, boolean> };
    expect(Object.keys(body).sort()).toEqual(["counts", "generatedAt", "items", "kind", "privacy", "shareId"]);
    expect(body.items.length).toBeGreaterThanOrEqual(6);
    for (const it of body.items) {
      expect(Object.keys(it).sort()).toEqual(["actor", "at", "category"]);
      expect(ACTIVITY_CATEGORIES as readonly string[]).toContain(it["category"]);
      expect(["owner", "agent", "executor", "system"]).toContain(it["actor"]);
      expect(String(it["at"])).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
    const tail = body.items.slice(-6).map((i) => i["category"]);
    expect(tail).toEqual(["decision", "trade", "execution", "wait", "recovery", "other"]);
    // 隐私：去掉时间戳后，正文里不得出现任何数字串（金额 / 数量）、地址、id、自由文本
    const stripped = r.text.replace(/"(at|generatedAt|shareId)":"[^"]+"/g, "");
    expect(stripped).not.toMatch(/0x[0-9a-fA-F]+/);
    expect(stripped.toLowerCase()).not.toContain(owner);
    for (const leak of ["123456789", "50000000", "250000000000000000", "AAPLx", "USDG", "payrolls", "free text", "int_deadbeef", "mnd_cafe", taskId, "some_future_type", "intent_certified", '"note"', '"ref"', '"data":{', '"type"']) expect(stripped, leak).not.toContain(leak);
    // 只有计数（安全整数）是数字
    expect(stripped.replace(/"counts":\{[^}]*\}/, "")).not.toMatch(/\d/);

    // 关闭 → 404；其它 kind 的分享 id 也读不到
    expect((await web(env, "POST", `/v1/tasks/${taskId}/share-activity`, { public: false })).json["publicUrl"]).toBeNull();
    expect((await pub(env, `/pub/tasks/${shareId}/activity`)).status).toBe(404);
    expect((await pub(env, `/pub/tasks/shr_nope/activity`)).status).toBe(404);
    // 战报公开入口不会把本 kind 当战报吐出来
    expect((await pub(env, `/pub/reports/${shareId}`)).status).toBe(404);
  });

  it("服务端缓存 5 s：5 s 内新条目不出现，过 5 s 后出现", async () => {
    env = await createTestEnv({ extraKeys: WEB_KEYS, now: T0 });
    const created = await web(env, "POST", "/v1/tasks", goalTaskBody());
    const taskId = (created.json["task"] as { id: string }).id;
    const shareId = (await web(env, "POST", `/v1/tasks/${taskId}/share-activity`, {})).json["shareId"] as string;
    const n0 = (JSON.parse((await pub(env, `/pub/tasks/${shareId}/activity`)).text) as { items: unknown[] }).items.length;
    await appendTimeline(env.db, taskId, { at: "2026-09-18T15:00:01.000Z", type: "agent_tool", note: "x" }, "agent:hosted");
    env.setNow("2026-09-18T15:00:04.000Z");
    expect((JSON.parse((await pub(env, `/pub/tasks/${shareId}/activity`)).text) as { items: unknown[] }).items.length).toBe(n0);
    env.setNow("2026-09-18T15:00:05.500Z");
    expect((JSON.parse((await pub(env, `/pub/tasks/${shareId}/activity`)).text) as { items: unknown[] }).items.length).toBe(n0 + 1);
  });
});
