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

export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()): boolean {
  const b = buckets.get(key);
  if (!b || now >= b.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    if (buckets.size > 5000) for (const [k, v] of buckets) if (now >= v.resetAt) buckets.delete(k);
    return true;
  }
  if (b.count >= limit) return false;
  b.count += 1;
  return true;
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
        res.status(400).json({ error: "missing_caller", message: "该 key 需要 x-verify-caller: <EVM 地址>" });
        return;
      }
      callerId = `${callerId.slice(0, -1)}${sub}`;
    }
    if (!rateLimit(`caller:${callerId}`, perMin, 60_000)) {
      res.status(429).json({ error: "rate_limited", retryAfterSeconds: 60 });
      return;
    }
    res.locals["callerId"] = callerId;
    next();
  };
}
