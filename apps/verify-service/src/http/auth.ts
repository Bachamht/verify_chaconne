/**
 * 调用方身份：API key（x-api-key 或 Authorization: Bearer）→ callerId；每调用方独立限频（I-01 / I-06）。
 * 不缓存鉴权结果到共享缓存；所有 /v1/jobs 响应 Cache-Control: private, no-store（I-02）。
 */
import type { NextFunction, Request, Response } from "express";
import type { ApiKeyEntry } from "../config";

/** 调用方 ID 存在 res.locals（不做全局类型增强，避免与 express 类型版本耦合） */
export function callerOf(res: Response): string {
  const id = res.locals["callerId"];
  if (typeof id !== "string" || !id) throw new Error("callerId 缺失：鉴权中间件未运行");
  return id;
}

interface Bucket {
  count: number;
  resetAt: number;
}
const buckets = new Map<string, Bucket>();

export interface RateLimitInfo {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** 距窗口重置的秒数（向上取整，≥1） */
  resetSeconds: number;
}

/** 固定窗口计数；返回标准 RateLimit-* 头所需的信息 */
export function rateLimitInfo(key: string, limit: number, windowMs: number, now = Date.now()): RateLimitInfo {
  let b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
    if (buckets.size > 5000) for (const [k, v] of buckets) if (now >= v.resetAt) buckets.delete(k);
  }
  const resetSeconds = Math.max(1, Math.ceil((b.resetAt - now) / 1000));
  if (b.count >= limit) return { allowed: false, limit, remaining: 0, resetSeconds };
  b.count += 1;
  return { allowed: true, limit, remaining: Math.max(0, limit - b.count), resetSeconds };
}

export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  return rateLimitInfo(key, limit, windowMs, now).allowed;
}

/**
 * 免 key 端点的按 IP 限流（V-42）：标准 `RateLimit-Limit / RateLimit-Remaining / RateLimit-Reset` 头，超限 429 + `Retry-After` + JSON。
 * 带合法 API key 的请求不走 IP 桶（它们已按调用方限频；主站代理就是这样打过来的）。
 * /a2mcp/* 的 429 正文沿用 { ok:false, status:"rate_limited" } 形态。
 */
export function freeRateLimiter(o: { perMin: number; validKeys: ReadonlySet<string>; now?: () => number; windowMs?: number }) {
  const windowMs = o.windowMs ?? 60_000;
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = (req.header("x-api-key") || req.header("authorization")?.replace(/^Bearer\s+/i, "") || "").trim();
    if (key && o.validKeys.has(key)) {
      next();
      return;
    }
    const info = rateLimitInfo(`free:${req.ip ?? "unknown"}`, o.perMin, windowMs, o.now ? o.now() : Date.now());
    res.setHeader("RateLimit-Limit", String(info.limit));
    res.setHeader("RateLimit-Remaining", String(info.remaining));
    res.setHeader("RateLimit-Reset", String(info.resetSeconds));
    if (info.allowed) {
      next();
      return;
    }
    res.setHeader("Retry-After", String(info.resetSeconds));
    res.setHeader("Cache-Control", "no-store");
    const message = `Rate limit exceeded: ${info.limit} requests per ${Math.round(windowMs / 1000)} s per client IP on free endpoints. Retry after ${info.resetSeconds} s, or use an API key.`;
    // 经 app.use(paths, mw) 挂载时 req.path 是相对挂载点的，要用 baseUrl + path 判断
    if (`${req.baseUrl}${req.path}`.startsWith("/a2mcp/")) {
      res.setHeader("X-A2MCP-Status", "rate_limited");
      res.status(429).json({ ok: false, status: "rate_limited", error: "rate_limited", message, retryAfterSeconds: info.resetSeconds, limit: info.limit, windowSeconds: Math.round(windowMs / 1000) });
      return;
    }
    res.status(429).json({ error: "rate_limited", message, retryAfterSeconds: info.resetSeconds, limit: info.limit, windowSeconds: Math.round(windowMs / 1000) });
  };
}

export function resetRateLimits(): void {
  buckets.clear();
}

export function apiKeyAuth(entries: ApiKeyEntry[], perMin: number) {
  const byKey = new Map(entries.map((e) => [e.key, e.callerId]));
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.header("x-api-key") || req.header("authorization")?.replace(/^Bearer\s+/i, "") || "";
    const key = header.trim();
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Vary", "x-api-key, authorization");
    if (!key) {
      res.status(401).json({ error: "missing_api_key" });
      return;
    }
    let callerId = byKey.get(key);
    if (!callerId) {
      res.status(403).json({ error: "invalid_api_key" });
      return;
    }
    // 通配调用方（如 "web*"）：受信代理按终端用户钱包地址细分 callerId（任务按地址隔离，I-01）
    if (callerId.endsWith("*")) {
      const sub = (req.header("x-verify-caller") ?? "").trim().toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(sub)) {
        res.status(400).json({ error: "missing_caller", message: "This key requires x-verify-caller: <EVM address>", messageZh: "该 key 需要 x-verify-caller: <EVM 地址>" });
        return;
      }
      callerId = `${callerId.slice(0, -1)}${sub}`;
    }
    if (!rateLimit(`caller:${callerId}`, perMin, 60_000)) {
      res.setHeader("Retry-After", "60");
      res.status(429).json({ error: "rate_limited", message: `Rate limit exceeded for this API key (${perMin}/min). Retry after 60 s.`, retryAfterSeconds: 60 });
      return;
    }
    res.locals["callerId"] = callerId;
    next();
  };
}
