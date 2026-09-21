"use client";
/** 浏览器 → 本站代理（/api/verify/*）→ verify-service。API key 只在服务端。 */

export interface AssetsResponse {
  registryVersion: string;
  registryHash: string;
  chainId: number;
  evidenceMode: "LIVE" | "FIXTURE";
  assets: Array<{ assetKey: string; tokenAddress: string; tokenDecimals: number; displaySymbol: string; underlyingId: string; role: "stable_input" | "stock_output"; executionAllowed: boolean }>;
}

export async function api<T>(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; data: T; headers: Headers }> {
  const res = await fetch(`/api/verify/${path.replace(/^\//, "")}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: "invalid_json", raw: text };
  }
  return { status: res.status, data: data as T, headers: res.headers };
}
