/** v6 Lane C · C4 通知与执行器：Q-05～Q-08 */
import { afterEach, describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { eq } from "drizzle-orm";
import { verifyNotificationChannels, verifyNotificationOutbox } from "@chaconne/db";
import { T_REGULAR } from "@chaconne/core/verify/fixtures";
import { forbiddenKeysIn } from "@chaconne/core/verify/budget/index";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, type TelegramSender, type TimelineSink } from "../src/notify/service";
import { api, createTestEnv, OTHER_API_KEY, type TestEnv } from "./helpers";
import { OWNER, registerBuyMandate } from "./v6helpers";

let env: TestEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});

const SECRET = "whsec_0123456789abcdef";
const plus = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

describe("Q-05 outbox 幂等、重复通知不重复步骤", () => {
  it("同 type:entityId:version 两次入队只一条；载荷只含 id/类型/版本/摘要/链接；HMAC 可验；接收方按通知重取步骤不会拿到第二份证书", async () => {
    env = await createTestEnv({ now: T_REGULAR });
    const m = await registerBuyMandate(env, { clientRequestId: "q05", nonce: "501" });
    const wh = await api(env, "POST", "/v1/notify/webhooks", { ownerAddress: OWNER, url: "http://127.0.0.1:1/hook", secret: SECRET });
    expect(wh.status).toBe(201);
    const first = await env.notify.notify("task.step_ready", m.id, 1, "step 0 ready", `http://test/v1/mandates/${m.id}`, OWNER);
    const dup = await env.notify.notify("task.step_ready", m.id, 1, "step 0 ready (retry)", `http://test/v1/mandates/${m.id}`, OWNER);
    expect(first.enqueued).toBe(true);
    expect(dup).toMatchObject({ enqueued: false, outboxId: first.outboxId, idempotencyKey: `task.step_ready:${m.id}:1` });
    expect(await env.db.select().from(verifyNotificationOutbox)).toHaveLength(1);
    const d1 = await env.notify.dispatchOnce();
    expect(d1).toMatchObject({ picked: 1, sent: 1, failed: 0 });
    expect(await env.notify.dispatchOnce()).toMatchObject({ picked: 0 });
    expect(env.webhookCalls).toHaveLength(1);
    const call = env.webhookCalls[0]!;
    const payload = JSON.parse(call.body) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["at", "entityId", "idempotencyKey", "summary", "type", "url", "version"]);
    expect(forbiddenKeysIn(payload)).toEqual([]);
    const expected = `sha256=${createHmac("sha256", SECRET).update(`${call.headers[TIMESTAMP_HEADER]}.${call.body}`).digest("hex")}`;
    expect(call.headers[SIGNATURE_HEADER]).toBe(expected);
    expect(call.headers["x-chaconne-idempotency-key"]).toBe(first.idempotencyKey);
    // 接收方收到（重复的）通知后重新 prepare-step：同一步只有一份未过期证书，不会重复签发
    const p1 = await api(env, "POST", `/v1/mandates/${m.id}/prepare-step`, {});
    const p2 = await api(env, "POST", `/v1/mandates/${m.id}/prepare-step`, {});
    expect(p1.json["stepIndex"]).toBe(0);
    expect(p2.json["stepIndex"]).toBe(0);
    expect(p2.json["stepDigest"]).toBe(p1.json["stepDigest"]);
    expect(((await api(env, "GET", `/v1/mandates/${m.id}`)).json["stepRecords"] as unknown[]).length).toBe(1);
  });
});

describe("Q-06 webhook HMAC / 重试 / 停用", () => {
  it("接收端持续 500：三次尝试后渠道 disabled、outbox failed、任务时间线收到 notification_channel_disabled", async () => {
    const timeline: Array<{ entityId: string; kind: string; detail: Record<string, unknown> }> = [];
    const sink: TimelineSink = { append: async (e) => { timeline.push(e); } };
    let calls = 0;
    env = await createTestEnv({ now: T_REGULAR, timeline: sink, webhookFetch: async () => { calls += 1; return { ok: false, status: 500 }; } });
    await registerBuyMandate(env, { clientRequestId: "q06", nonce: "601" });
    const wh = await api(env, "POST", "/v1/notify/webhooks", { ownerAddress: OWNER, url: "http://127.0.0.1:1/hook", secret: SECRET });
    const channelId = wh.json["channelId"] as string;
    await env.notify.notify("task.blocked", "tsk_q06", 1, "blocked", "http://test/t", OWNER);
    expect(await env.notify.dispatchOnce()).toMatchObject({ picked: 1, failed: 1, disabledChannels: [] });
    expect(await env.notify.dispatchOnce()).toMatchObject({ picked: 0 }); // 退避中
    env.setNow(plus(T_REGULAR, 11_000));
    expect(await env.notify.dispatchOnce()).toMatchObject({ picked: 1, failed: 1 });
    env.setNow(plus(T_REGULAR, 11_000 + 61_000));
    const third = await env.notify.dispatchOnce();
    expect(third).toMatchObject({ picked: 1, failed: 1, disabledChannels: [channelId] });
    expect(calls).toBe(3);
    const ch = (await env.db.select().from(verifyNotificationChannels).where(eq(verifyNotificationChannels.id, channelId)))[0]!;
    expect(ch).toMatchObject({ state: "disabled", consecutiveFailures: 3, disabledReason: "3_consecutive_failures" });
    const ob = (await env.db.select().from(verifyNotificationOutbox))[0]!;
    expect(ob.state).toBe("failed");
    expect(ob.attempts).toBe(3);
    expect(timeline.map((t) => t.kind)).toEqual(["notification_channel_disabled", "notification_failed"]);
    expect(timeline[0]).toMatchObject({ entityId: "tsk_q06", detail: { channelId, failures: 3, lastStatus: 500 } });
    // 停用后新通知不再投递到该渠道
    await env.notify.notify("task.blocked", "tsk_q06", 2, "blocked again", "http://test/t", OWNER);
    expect(await env.notify.dispatchOnce()).toMatchObject({ picked: 1, sent: 1 });
    expect(calls).toBe(3);
    expect((await api(env, "GET", `/v1/notify/webhooks/${channelId}`)).json["state"]).toBe("disabled");
    expect((await api(env, "GET", `/v1/notify/webhooks/${channelId}`, undefined, {}, OTHER_API_KEY)).status).toBe(403);
    expect((await api(env, "DELETE", `/v1/notify/webhooks/${channelId}`)).status).toBe(204);
    expect((await api(env, "POST", "/v1/notify/webhooks", { ownerAddress: OWNER, url: "ftp://x", secret: SECRET })).status).toBe(400);
  });
});

describe("Q-07 Telegram 链接码与推送", () => {
  it("token 未配置 → 503 not_configured", async () => {
    env = await createTestEnv({ now: T_REGULAR });
    await registerBuyMandate(env, { clientRequestId: "q07a", nonce: "701" });
    const r = await api(env, "POST", "/v1/notify/telegram/link", { ownerAddress: OWNER });
    expect(r.status).toBe(503);
    expect(r.json["error"]).toBe("not_configured");
  });
  it("发码 → 用 chatId + 码确认（bot 只推送一条含码消息）→ active；派发时推送到该 chat；错码 404、过期 410", async () => {
    const sent: Array<{ chatId: string; text: string }> = [];
    const tg: TelegramSender = { send: async (chatId, text) => { sent.push({ chatId, text }); return { ok: true, status: 200 }; } };
    env = await createTestEnv({ now: T_REGULAR, telegram: tg });
    await registerBuyMandate(env, { clientRequestId: "q07b", nonce: "702" });
    const issued = await api(env, "POST", "/v1/notify/telegram/link", { ownerAddress: OWNER });
    expect(issued.status).toBe(201);
    expect(issued.json["step"]).toBe("code_issued");
    const code = issued.json["code"] as string;
    expect(code).toMatch(/^[0-9A-F]{8}$/);
    expect((await api(env, "POST", "/v1/notify/telegram/link", { ownerAddress: OWNER, code: "DEADBEEF", chatId: "12345" })).status).toBe(404);
    const linked = await api(env, "POST", "/v1/notify/telegram/link", { ownerAddress: OWNER, code, chatId: "12345" });
    expect(linked.status).toBe(200);
    expect(linked.json["step"]).toBe("linked");
    expect((linked.json["channel"] as { state: string; target: string }).state).toBe("active");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.chatId).toBe("12345");
    expect(sent[0]!.text).toContain(code);
    // 派发
    await env.notify.notify("task.step_confirmed", "tsk_q07", 3, "step 0 confirmed", "http://test/t", OWNER);
    expect(await env.notify.dispatchOnce()).toMatchObject({ sent: 1 });
    expect(sent[1]!.text).toContain("task.step_confirmed");
    expect(sent[1]!.text).not.toMatch(/signature|calldata|certificate/i);
    // 过期码
    const again = await api(env, "POST", "/v1/notify/telegram/link", { ownerAddress: OWNER });
    env.setNow(plus(T_REGULAR, 11 * 60_000));
    expect((await api(env, "POST", "/v1/notify/telegram/link", { ownerAddress: OWNER, code: again.json["code"], chatId: "12345" })).status).toBe(410);
    // /v1/notify/test
    const t = await api(env, "POST", "/v1/notify/test", { ownerAddress: OWNER });
    expect(t.status).toBe(200);
    expect(t.json["state"]).toBe("sent");
  });
});

describe("Q-08 执行器三态与页面文案", () => {
  it("心跳 204 → online；3 分钟后 offline；browser_wallet 路径 → awaiting_signature；组合视图带 executor", async () => {
    env = await createTestEnv({ now: T_REGULAR });
    const m = await registerBuyMandate(env, { clientRequestId: "q08", nonce: "801" });
    expect((await api(env, "GET", `/v1/mandates/${m.id}/executor`)).json).toMatchObject({ presence: "offline", lastSeenAt: null, heartbeatIntervalSeconds: 60 });
    const hb = await api(env, "POST", `/v1/mandates/${m.id}/executor/heartbeat`, { executorId: "agent-1", path: "agent_wallet" });
    expect(hb.status).toBe(204);
    let p = (await api(env, "GET", `/v1/mandates/${m.id}/executor`)).json;
    expect(p["presence"]).toBe("online");
    expect(String(p["text"])).toMatch(/unattended/);
    env.setNow(plus(T_REGULAR, 3 * 60_000 + 1000));
    p = (await api(env, "GET", `/v1/mandates/${m.id}/executor`)).json;
    expect(p["presence"]).toBe("offline");
    expect(String(p["text"])).toMatch(/No executor heartbeat/);
    await api(env, "POST", `/v1/mandates/${m.id}/executor/heartbeat`, { executorId: "browser", path: "browser_wallet" });
    p = (await api(env, "GET", `/v1/mandates/${m.id}/executor`)).json;
    expect(p["presence"]).toBe("awaiting_signature");
    expect(String(p["text"])).toMatch(/nothing is scheduled unattended/);
    const port = await api(env, "GET", `/v1/portfolio/${OWNER}`);
    expect(((port.json["authorizations"] as Array<{ executor: { presence: string } }>)[0]!).executor.presence).toBe("awaiting_signature");
    expect((await api(env, "POST", `/v1/mandates/${m.id}/executor/heartbeat`, { path: "agent_wallet" }, {}, OTHER_API_KEY)).status).toBe(403);
    expect((await api(env, "POST", `/v1/mandates/mnd_nope/executor/heartbeat`, {})).status).toBe(404);
  });
});
