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
