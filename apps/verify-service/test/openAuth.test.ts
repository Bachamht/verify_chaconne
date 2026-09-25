/** 开放模式（2026-09-25）：暂时所有服务不需要 key——无 key 按 x-verify-caller 当调用方，与网页同一命名空间；运营者端点只认 key */
import { afterEach, describe, expect, it } from "vitest";
import { FIXTURE_STABLE_KEY, FIXTURE_STOCK_KEY } from "@chaconne/core/verify/fixtures";
import { api, createTestEnv, type TestEnv } from "./helpers";

let env: TestEnv | null = null;
afterEach(async () => { await env?.close(); env = null; });
const OWNER = "0x70997970c51812dc3a010c7d01b50e0d17dc79c8";
const body = (id: string) => ({ clientRequestId: id, mode: "SIMULATION", ownerAddress: OWNER, scope: { objective: "open", outputAssetKeys: [FIXTURE_STOCK_KEY], budgetCapRaw: "1000000", perStepCapRaw: "500000", inputAssetKey: FIXTURE_STABLE_KEY } });

describe("VERIFY_AUTH_OPEN=true（显式开启；缺省已关，FIX-175）", () => {
  it("无 key + x-verify-caller → 调用方 web:<地址>：建的任务与带网页通配 key 的同一地址互见；无 key 无地址 → anon，看不到别人的；运营者端点 403；错 key 仍 403", async () => {
    env = await createTestEnv({ extraKeys: "vk_web_t:web:*", env: { VERIFY_AUTH_OPEN: "true" } });
    const created = await api(env, "POST", "/v1/tasks", body("o1"), { "x-verify-caller": OWNER }, "");
    expect(created.status, JSON.stringify(created.json).slice(0, 200)).toBe(201);
    const id = (created.json["task"] as { id: string }).id;
    // 网页通配 key + 同一地址 → 同一调用方
    const viaWeb = await api(env, "GET", `/v1/tasks/${id}`, undefined, { "x-verify-caller": OWNER }, "vk_web_t");
    expect(viaWeb.status).toBe(200);
    // 无 key、另一个地址 → 403（按地址隔离）
    expect((await api(env, "GET", `/v1/tasks/${id}`, undefined, { "x-verify-caller": "0x1111111111111111111111111111111111111111" }, "")).status).toBe(403);
    // 无 key 无地址 → anon：请求体给 ownerAddress 也能建，但看不到 web:<地址> 的任务
    const anon = await api(env, "POST", "/v1/tasks", body("o2"), {}, "");
    expect(anon.status, JSON.stringify(anon.json).slice(0, 200)).toBe(201);
    expect((await api(env, "GET", `/v1/tasks/${id}`, undefined, {}, "")).status).toBe(403);
    // 运营者端点：开放调用方永远 403
    const ing = await api(env, "POST", "/v1/events/earnings/ingest", {}, { "x-verify-caller": OWNER }, "");
    expect([403, 404]).toContain(ing.status);
    if (ing.status === 403) expect(ing.json["error"]).toBe("operator_only");
    // 带了错误的 key 仍拒绝
    expect((await api(env, "GET", `/v1/tasks/${id}`, undefined, { "x-verify-caller": OWNER }, "vk_wrong")).status).toBe(403);
  });
  it("缺省（VERIFY_AUTH_OPEN 未设）→ 无 key 401 missing_api_key", async () => {
    env = await createTestEnv();
    const r = await api(env, "GET", "/v1/tasks", undefined, { "x-verify-caller": OWNER }, "");
    expect(r.status).toBe(401);
    expect(r.json["error"]).toBe("missing_api_key");
  });
});
