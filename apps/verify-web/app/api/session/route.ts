/**
 * 网站钱包登录（FIX-175）：GET 发 nonce（签名 cookie，10 分钟）→ 钱包 personal_sign 登录消息 → POST 验签 → 会话 cookie（30 天，httpOnly）。
 * 之后代理只把「会话里的地址」当调用方；请求里写别的真实地址一律 401 wallet_signin_required。占位地址（无钱包模拟）不需要登录。
 */
import { cookies } from "next/headers";
import { NextResponse, type NextRequest } from "next/server";
import { verifyMessage } from "viem";
import { walletSignInMessage } from "@chaconne/core/verify";
import { NONCE_COOKIE, NONCE_TTL_MS, newNonce, nonceFields, nonceToken, SESSION_COOKIE, SESSION_TTL_MS, sessionAddress, sessionSecret, sessionToken } from "@/lib/sessionToken";

const secure = process.env["NODE_ENV"] === "production";
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const hostOf = (req: NextRequest) => (req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "").split(",")[0]!.trim();

export async function GET(req: NextRequest) {
  const secret = sessionSecret();
  if (!secret) return NextResponse.json({ error: "session_not_configured" }, { status: 500 });
  const jar = await cookies();
  const now = Date.now();
  const current = sessionAddress(jar.get(SESSION_COOKIE)?.value, secret, now);
  const nonce = newNonce();
  const issuedAt = new Date(now).toISOString();
  const res = NextResponse.json({ address: current, nonce, issuedAt, host: hostOf(req) }, { headers: { "cache-control": "private, no-store" } });
  res.cookies.set(NONCE_COOKIE, nonceToken(nonce, issuedAt, secret, now), { httpOnly: true, sameSite: "lax", secure, path: "/api", maxAge: Math.floor(NONCE_TTL_MS / 1000) });
  return res;
}

export async function POST(req: NextRequest) {
  const secret = sessionSecret();
  if (!secret) return NextResponse.json({ error: "session_not_configured" }, { status: 500 });
  let body: { address?: unknown; nonce?: unknown; issuedAt?: unknown; signature?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const address = typeof body.address === "string" && ADDRESS.test(body.address) ? body.address.toLowerCase() : "";
  const signature = typeof body.signature === "string" && /^0x[0-9a-fA-F]{130}$/.test(body.signature) ? body.signature : "";
  if (!address || !signature || typeof body.nonce !== "string" || typeof body.issuedAt !== "string") return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  const jar = await cookies();
  const now = Date.now();
  const issued = nonceFields(jar.get(NONCE_COOKIE)?.value, secret, now);
  if (!issued || issued.nonce !== body.nonce || issued.issuedAt !== body.issuedAt) return NextResponse.json({ error: "nonce_expired", message: "Sign-in challenge expired or did not match; start again." }, { status: 400 });
  const message = walletSignInMessage({ host: hostOf(req), address, nonce: issued.nonce, issuedAt: issued.issuedAt });
  let ok = false;
  try {
    ok = await verifyMessage({ address: address as `0x${string}`, message, signature: signature as `0x${string}` });
  } catch {
    ok = false;
  }
  if (!ok) return NextResponse.json({ error: "bad_signature" }, { status: 401 });
  const res = NextResponse.json({ ok: true, address }, { headers: { "cache-control": "private, no-store" } });
  res.cookies.set(SESSION_COOKIE, sessionToken(address, secret, now), { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: Math.floor(SESSION_TTL_MS / 1000) });
  res.cookies.set(NONCE_COOKIE, "", { httpOnly: true, sameSite: "lax", secure, path: "/api", maxAge: 0 });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", secure, path: "/", maxAge: 0 });
  return res;
}

export const dynamic = "force-dynamic";
