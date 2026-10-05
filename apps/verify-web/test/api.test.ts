/** V-29 · 全站唯一 fetch 出口：绝对路径 /api/verify/…；超时与网络错误回 status 0 + 可机读 error，不抛出。 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { api, API_SLOW_MS, API_TIMEOUT_MS } from "../lib/api";
import { apiError } from "../lib/errors";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe("api()", () => {
  it("路径总是 /api/verify/ 开头的绝对路径（去掉多余前导斜杠）", async () => {
    const seen: string[] = [];
    globalThis.fetch = (async (url: string | URL | Request) => { seen.push(String(url)); return new Response("{}", { status: 200, headers: { "content-type": "application/json" } }); }) as typeof fetch;
    await api("GET", "v1/event-impacts?owner=0x1");
    await api("GET", "/v1/assets");
    expect(seen).toEqual(["/api/verify/v1/event-impacts?owner=0x1", "/api/verify/v1/assets"]);
  });
  it("超过 timeoutMs 中止 → status 0 / error timeout；apiError 给人话", async () => {
    globalThis.fetch = ((_: unknown, init?: RequestInit) => new Promise((_res, rej) => { init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))); })) as typeof fetch;
    const r = await api<{ error: string }>("GET", "v1/tasks", undefined, {}, { timeoutMs: 20 });
    expect(r.status).toBe(0);
    expect(r.data.error).toBe("timeout");
    expect(apiError(r, "zh")).toContain("30 秒");
  });
  it("网络错误 → status 0 / error service_unreachable（不抛出）", async () => {
    globalThis.fetch = (async () => { throw new TypeError("Failed to fetch"); }) as typeof fetch;
    const r = await api<{ error: string }>("GET", "v1/assets");
    expect(r.status).toBe(0);
    expect(r.data.error).toBe("service_unreachable");
  });
  it("10 s 提示、30 s 判失败", () => {
    expect(API_SLOW_MS).toBe(10_000);
    expect(API_TIMEOUT_MS).toBe(30_000);
    vi.restoreAllMocks();
  });
});

describe("mandates.get：步骤列表（2026-10-03 任务页成交回执为空的回归）", () => {
  it("服务端把步骤放在 stepRecords、steps 是计数 → 归一成 steps 数组；旧形状（steps 数组）原样保留", async () => {
    const { mandates } = await import("../lib/api-v2");
    const rec = { stepIndex: "0", state: "CONFIRMED", step: null, stepDigest: null, validUntil: null, txHash: "0xabc", receipt: { event: { spent: "1000000", received: "5" } } };
    globalThis.fetch = (async () => new Response(JSON.stringify({ mandateId: "mnd_1", steps: { done: 1, max: 2 }, stepRecords: [rec] }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    const a = await mandates.get("mnd_1");
    expect(Array.isArray(a.data.steps)).toBe(true);
    expect(a.data.steps[0]!.txHash).toBe("0xabc");
    globalThis.fetch = (async () => new Response(JSON.stringify({ mandateId: "mnd_2", steps: [rec] }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;
    expect((await mandates.get("mnd_2")).data.steps).toHaveLength(1);
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers: { "content-type": "application/json" } })) as typeof fetch;
    expect((await mandates.get("mnd_3")).status).toBe(404);
  });
});
