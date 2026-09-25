/** V-28 已知路径错误方法 → 405 + Allow */
import { afterEach, describe, expect, it } from "vitest";
import { api, createTestEnv, type TestEnv } from "./helpers";

let env: TestEnv | null = null;
afterEach(async () => {
  await env?.close();
  env = null;
});


describe("V-28 错误方法 → 405 + Allow", () => {
  it("POST /v1/tasks/:id/explain-wait → 405 Allow: GET, HEAD, OPTIONS；PATCH /v1/tasks/:id → 405 列出 GET 与 DELETE；未知路径仍 404", async () => {
    env = await createTestEnv();
    const r = await api(env, "POST", "/v1/tasks/tsk_x/explain-wait", {});
    expect(r.status).toBe(405);
    expect(r.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
    expect(r.json["error"]).toBe("method_not_allowed");
    expect(r.json["allow"]).toEqual(["GET", "HEAD", "OPTIONS"]);
    // 批次 7：DELETE /v1/tasks/:id 成了真实方法（删除 = 归档）；错误方法改用 PATCH 检查
    const del = await api(env, "PATCH", "/v1/tasks/tsk_x");
    expect(del.status).toBe(405);
    expect(del.headers.get("allow")).toContain("GET");
    expect(del.headers.get("allow")).toContain("DELETE");
    expect((await api(env, "DELETE", "/v1/tasks/tsk_x")).status).toBe(403);
    const put = await api(env, "PUT", "/v1/assets");
    expect(put.status).toBe(405);
    expect((await api(env, "GET", "/v1/nope")).status).toBe(404);
    // 正确方法照常（这里 explain-wait 对不存在的任务 404，不是 405）
    expect((await api(env, "GET", "/v1/tasks/tsk_x/explain-wait")).status).toBe(404);
  });
});

