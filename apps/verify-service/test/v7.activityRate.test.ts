/** v7（interfaces §12.8 末条）：GET /v1/tasks/:id/activity 单独计数 ≥ 120/min，不挤占普通每分钟额度 */
import { afterEach, describe, expect, it } from "vitest";
import express from "express";
import type { AddressInfo } from "node:net";
import { apiKeyAuth, resetRateLimits } from "../src/http/auth";

describe("活动流单独限频", () => {
  afterEach(() => resetRateLimits());
  it("普通请求 60/min 用完后，活动流仍可轮询到 120/min；活动流不占普通额度", async () => {
    const app = express();
    app.use(apiKeyAuth([{ key: "k1", callerId: "web:0x1111111111111111111111111111111111111111" }], 60));
    app.get("/v1/tasks/:id/activity", (_req, res) => { res.json({ ok: true }); });
    app.get("/v1/tasks/:id", (_req, res) => { res.json({ ok: true }); });
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const hit = (p: string) => fetch(base + p, { headers: { "x-api-key": "k1" } }).then((r) => r.status);
    try {
      for (let i = 0; i < 120; i++) expect(await hit("/v1/tasks/t1/activity")).toBe(200);
      expect(await hit("/v1/tasks/t1/activity")).toBe(429);
      for (let i = 0; i < 60; i++) expect(await hit("/v1/tasks/t1")).toBe(200);
      expect(await hit("/v1/tasks/t1")).toBe(429);
    } finally {
      server.close();
    }
  });
});
