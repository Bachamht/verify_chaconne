"use client";
/**
 * 浏览器 → 本站代理（/api/verify/*）→ verify-service。API key 只在服务端。
 * 全站唯一的 fetch 出口（V-29 / 4.6-5）：绝对路径；30 s 超时（status 0 + error "timeout"）；网络错误也回 status 0 而不是抛出，
 * 页面统一按 status / error 显示「重试」。10 s「还在加载」由 LoadingState 组件负责，与这里的硬超时分开。
 */

export interface AssetsResponse {
  registryVersion: string;
  registryHash: string;
  chainId: number;
  evidenceMode: "LIVE" | "FIXTURE";
  assets: Array<{ assetKey: string; tokenAddress: string; tokenDecimals: number; displaySymbol: string; underlyingId: string; role: "stable_input" | "stock_output"; executionAllowed: boolean }>;
}

export const API_TIMEOUT_MS = 30_000;
/** 超过这个时间页面显示「还在加载 · 重试」 */
export const API_SLOW_MS = 10_000;

export async function api<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}, opts: { timeoutMs?: number } = {}): Promise<{ status: number; data: T; headers: Headers }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? API_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`/api/verify/${path.replace(/^\/+/, "")}`, {
      method,
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
      signal: ctrl.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const aborted = (e as { name?: string } | null)?.name === "AbortError";
    return { status: 0, data: { error: aborted ? "timeout" : "service_unreachable" } as T, headers: new Headers() };
  }
  clearTimeout(timer);
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: "invalid_json", raw: text };
  }
  return { status: res.status, data: data as T, headers: res.headers };
}
