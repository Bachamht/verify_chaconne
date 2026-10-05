/**
 * 调用方身份：API key（x-api-key 或 Authorization: Bearer）→ callerId；每调用方独立限频（I-01 / I-06）。
 * 不缓存鉴权结果到共享缓存；所有 /v1/jobs 响应 Cache-Control: private, no-store（I-02）。
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import type { ApiKeyEntry } from "../config";

/* ---------------- v7（D-093 / CV-D25）：服务 key —— authKind = "service" ---------------- */

/** 服务调用方：平台执行身份 / 托管 Agent。它们不是运营者（SEC-01），也不代表任何 owner（SEC-09） */
export const SERVICE_CALLERS = ["executor:hosted", "agent:hosted"] as const;
export type ServiceCaller = (typeof SERVICE_CALLERS)[number];
export function isServiceCallerId(callerId: string | null | undefined): callerId is ServiceCaller {
  return callerId === "executor:hosted" || callerId === "agent:hosted";
}

/** 从请求取 API key（x-api-key 或 Authorization: Bearer） */
export function requestApiKey(req: Request): string {
  return (req.header("x-api-key") || req.header("authorization")?.replace(/^Bearer\s+/i, "") || "").trim();
}

/**
 * 服务 key 匹配器：verify-service 只存 SHA-256（VERIFY_EXECUTOR_KEY_SHA256 / VERIFY_HOSTED_AGENT_KEY_SHA256）；
 * 请求 key 求 SHA-256 后与两项都做常量时间比较（不因第一项命中而短路），空配置 = 该身份不可用。
 */
export function serviceKeyMatcher(hashes: { executor?: string | null; agent?: string | null }): (key: string) => ServiceCaller | null {
  const entries: Array<[ServiceCaller, Buffer | null]> = [
    ["executor:hosted", /^[0-9a-f]{64}$/.test(hashes.executor ?? "") ? Buffer.from(hashes.executor!, "hex") : null],
    ["agent:hosted", /^[0-9a-f]{64}$/.test(hashes.agent ?? "") ? Buffer.from(hashes.agent!, "hex") : null],
  ];
  return (key: string) => {
    if (!key) return null;
    const h = createHash("sha256").update(key, "utf8").digest();
    let hit: ServiceCaller | null = null;
    for (const [caller, want] of entries) {
      const eq = want ? timingSafeEqual(h, want) : timingSafeEqual(h, h) && false;
      if (eq && !hit) hit = caller;
    }
    return hit;
  };
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/**
 * 调用方是否代表该 owner 地址（钱包账户化的两条无需查库的规则）：
 *   1. 受信代理 / 开放模式细分出的 callerId 以 `:<owner>` 结尾（`web:0x…`、`a2mcp:owner:0x…`）；
 *   2. 调用方本身就是该地址。
 * 记录按钱包归属：同一钱包经网页、MCP（VERIFY_CALLER）、A2MCP 免 key 端点建的记录，互相都能读（FIX-174）。
 */
export function callerActsFor(callerId: string, owner: string | null | undefined): boolean {
  if (!owner) return false;
  const o = owner.toLowerCase();
  const c = callerId.toLowerCase();
  return c === o || c.endsWith(`:${o}`);
}

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
    // v7：服务 key 已由 registerV7AEarly 鉴权并单独限频（agent 300/min、executor 600/min），不走 IP 桶
    if (res.locals["authKind"] === "service") {
      next();
      return;
    }
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

/** 运营者判定：只有配置表里的、非地址绑定的 key 调用方算运营者；开放模式（无 key）的调用方永远不是；服务 key（authKind=service）永远不是（D-093 / SEC-01） */
export function isOperator(res: Response): boolean {
  const callerId = String(res.locals["callerId"] ?? "");
  return res.locals["authKind"] === "key" && !isServiceCallerId(callerId) && !/(0x[0-9a-f]{40})$/.test(callerId);
}

export interface ApiKeyAuthOptions {
  /** 开放模式（缺省关）：没带 key 也放行，按 x-verify-caller 当调用方 */
  open?: boolean;
  /** 钱包签发的 key（库里查哈希；FIX-175）：配置表里没有的 key 才走这里 */
  resolve?: (key: string) => Promise<{ callerId: string } | null>;
  /** 401 里告诉调用方去哪拿 key（网站的 /agent/keys） */
  keysUrl?: string;
}

/** v7（interfaces §12.8 末条）：活动流轮询单独计数，每调用方 ≥ 120/min，不挤占普通 60/min 额度 */
export const ACTIVITY_PER_MIN = 120;
const ACTIVITY_PATH = /^\/v1\/tasks\/[^/]+\/activity$/;
function bucketFor(req: Request, callerId: string, perMin: number): { key: string; limit: number } {
  if (req.method === "GET" && ACTIVITY_PATH.test(req.path)) return { key: `activity:${callerId}`, limit: Math.max(perMin, ACTIVITY_PER_MIN) };
  return { key: `caller:${callerId}`, limit: perMin };
}

export function apiKeyAuth(entries: ApiKeyEntry[], perMin: number, opts: ApiKeyAuthOptions = {}) {
  const byKey = new Map(entries.map((e) => [e.key, e.callerId]));
  const admit = (req: Request, res: Response, callerId: string, next: NextFunction): void => {
    const b = bucketFor(req, callerId, perMin);
    if (!rateLimit(b.key, b.limit, 60_000)) {
      res.setHeader("Retry-After", "60");
      res.status(429).json({ error: "rate_limited", message: `Rate limit exceeded for this caller (${b.limit}/min). Retry after 60 s.`, retryAfterSeconds: 60 });
      return;
    }
    res.locals["callerId"] = callerId;
    res.locals["authKind"] = "key";
    next();
  };
  return (req: Request, res: Response, next: NextFunction): void => {
    const header = req.header("x-api-key") || req.header("authorization")?.replace(/^Bearer\s+/i, "") || "";
    const key = header.trim();
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Vary", "x-api-key, authorization, x-verify-caller");
    // v7：服务 key 已在 registerV7AEarly 鉴权（默认拒绝白名单 + 轮次令牌）；这里不再查表、不改 authKind
    if (res.locals["authKind"] === "service" && isServiceCallerId(res.locals["callerId"] as string)) {
      next();
      return;
    }
    if (!key) {
      if (!opts.open) {
        res.status(401).json({
          error: "missing_api_key",
          message: `This endpoint needs an API key. Get one for your wallet${opts.keysUrl ? ` at ${opts.keysUrl}` : ""} (connect the wallet, sign one message, copy the key) and send it as x-api-key. Free endpoints (/v1/assets, /v1/context, /a2mcp/*, /pub/*) need none.`,
          keysUrl: opts.keysUrl ?? null,
        });
        return;
      }
      // 开放模式：x-verify-caller 给了钱包地址 → 与网页同一命名空间 web:<地址>（网页与 MCP 看到同一批任务）；没给 → anon:<ip>
      const sub = (req.header("x-verify-caller") ?? "").trim().toLowerCase();
      const callerId = /^0x[0-9a-f]{40}$/.test(sub) ? `web:${sub}` : `anon:${req.ip ?? "unknown"}`;
      const ob = bucketFor(req, callerId, perMin);
      if (!rateLimit(ob.key, ob.limit, 60_000)) {
        res.setHeader("Retry-After", "60");
        res.status(429).json({ error: "rate_limited", message: `Rate limit exceeded for this caller (${ob.limit}/min). Retry after 60 s.`, retryAfterSeconds: 60 });
        return;
      }
      res.locals["callerId"] = callerId;
      res.locals["authKind"] = "open";
      next();
      return;
    }
    let callerId = byKey.get(key);
    if (!callerId) {
      if (!opts.resolve) {
        res.status(403).json({ error: "invalid_api_key" });
        return;
      }
      opts
        .resolve(key)
        .then((hit) => {
          if (!hit) {
            res.status(403).json({ error: "invalid_api_key", message: `Unknown or revoked key. Issue a new one${opts.keysUrl ? ` at ${opts.keysUrl}` : ""}.`, keysUrl: opts.keysUrl ?? null });
            return;
          }
          admit(req, res, hit.callerId, next);
        })
        .catch(next);
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
    const kb = bucketFor(req, callerId, perMin);
    if (!rateLimit(kb.key, kb.limit, 60_000)) {
      res.setHeader("Retry-After", "60");
      res.status(429).json({ error: "rate_limited", message: `Rate limit exceeded for this API key (${kb.limit}/min). Retry after 60 s.`, retryAfterSeconds: 60 });
      return;
    }
    res.locals["callerId"] = callerId;
    res.locals["authKind"] = "key";
    next();
  };
}
