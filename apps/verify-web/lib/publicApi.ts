/**
 * 公开只读接口（不需要钱包登录）：营销壳的状态灯等用它，避免把 lib/api → lib/session → viem 拉进首页包（D6）。
 * 与 lib/api 同样走本站代理、30 s 超时、网络错误回 status 0。
 */
export async function publicGet<T>(path: string, timeoutMs = 30_000): Promise<{ status: number; data: T | null }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`/api/verify/${path.replace(/^\/+/, "")}`, { cache: "no-store", signal: ctrl.signal });
    const text = await res.text();
    let data: T | null = null;
    try {
      data = text ? (JSON.parse(text) as T) : null;
    } catch {
      data = null;
    }
    return { status: res.status, data };
  } catch {
    return { status: 0, data: null };
  } finally {
    clearTimeout(timer);
  }
}
