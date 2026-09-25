/**
 * 网站钱包登录的会话令牌（FIX-175）。只在服务端（代理路由 / 会话路由）用：HMAC-SHA256 签名的 `kind|字段…|到期毫秒|mac`。
 * 密钥：VERIFY_WEB_SESSION_SECRET，缺省用 VERIFY_WEB_API_KEY（本来就只在服务端）；生产环境两者都没有 → 登录不可用（500 session_not_configured）。
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "verify_session";
export const NONCE_COOKIE = "verify_nonce";
export const SESSION_TTL_MS = 30 * 24 * 3600_000;
export const NONCE_TTL_MS = 10 * 60_000;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const SEP = "|";

export function sessionSecret(env: Record<string, string | undefined> = process.env): string | null {
  return env["VERIFY_WEB_SESSION_SECRET"] || env["VERIFY_WEB_API_KEY"] || (env["NODE_ENV"] === "production" ? null : "dev-insecure-session-secret");
}

function mac(secret: string, payload: string): string {
  return createHmac("sha256", secret).update(payload).digest("base64url");
}

export function signToken(fields: string[], secret: string, expMs: number): string {
  if (fields.some((f) => f.includes(SEP))) throw new Error("token field contains separator");
  const payload = [...fields, String(Math.floor(expMs))].join(SEP);
  return `${payload}${SEP}${mac(secret, payload)}`;
}

/** 校验并返回字段（不含到期时间）；篡改 / 过期 / 格式不对 → null */
export function verifyToken(token: string | null | undefined, secret: string, nowMs: number): string[] | null {
  if (!token) return null;
  const parts = token.split(SEP);
  if (parts.length < 3) return null;
  const given = parts[parts.length - 1]!;
  const payload = parts.slice(0, -1).join(SEP);
  const expected = mac(secret, payload);
  if (given.length !== expected.length || !timingSafeEqual(Buffer.from(given), Buffer.from(expected))) return null;
  const exp = Number(parts[parts.length - 2]);
  if (!Number.isFinite(exp) || exp < nowMs) return null;
  return parts.slice(0, -2);
}

export function newNonce(): string {
  return randomBytes(16).toString("hex");
}

export function sessionToken(address: string, secret: string, nowMs: number): string {
  return signToken(["s", address.toLowerCase()], secret, nowMs + SESSION_TTL_MS);
}
export function sessionAddress(token: string | null | undefined, secret: string, nowMs: number): string | null {
  const f = verifyToken(token, secret, nowMs);
  if (!f || f[0] !== "s" || !ADDRESS.test(f[1] ?? "")) return null;
  return f[1]!;
}

export function nonceToken(nonce: string, issuedAt: string, secret: string, nowMs: number): string {
  return signToken(["n", nonce, issuedAt], secret, nowMs + NONCE_TTL_MS);
}
export function nonceFields(token: string | null | undefined, secret: string, nowMs: number): { nonce: string; issuedAt: string } | null {
  const f = verifyToken(token, secret, nowMs);
  if (!f || f[0] !== "n" || !f[1] || !f[2]) return null;
  return { nonce: f[1], issuedAt: f[2] };
}
