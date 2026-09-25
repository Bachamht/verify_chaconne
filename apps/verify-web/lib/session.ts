"use client";
/**
 * 钱包登录（FIX-175）：连接钱包只是读地址；要以这个地址读写记录，得签一条登录消息（不是交易、不花钱），换一个 30 天的 httpOnly 会话。
 * `api()` 收到代理的 401 wallet_signin_required 时自动走一遍这里再重试；页面也可以主动调 signIn。
 */
import { walletSignInMessage } from "@chaconne/core/verify";
import { restoreConnection, signMessage } from "./wallet";

let pending: Promise<boolean> | null = null;

export async function signIn(account: `0x${string}`): Promise<boolean> {
  const start = await fetch("/api/session", { method: "GET", cache: "no-store", credentials: "same-origin" });
  if (!start.ok) return false;
  const { nonce, issuedAt, host } = (await start.json()) as { nonce: string; issuedAt: string; host: string };
  const message = walletSignInMessage({ host: host || window.location.host, address: account, nonce, issuedAt });
  const signature = await signMessage(account, message);
  const res = await fetch("/api/session", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ address: account, nonce, issuedAt, signature }) });
  if (res.ok) window.dispatchEvent(new Event("verify:session"));
  return res.ok;
}

/** 已连接的钱包签一次登录消息；并发调用共用同一次弹窗。没连钱包 / 用户拒签 → false */
export function ensureSignedIn(): Promise<boolean> {
  if (pending) return pending;
  pending = (async () => {
    const account = await restoreConnection();
    if (!account) return false;
    try {
      return await signIn(account);
    } catch {
      return false;
    }
  })().finally(() => {
    pending = null;
  });
  return pending;
}

export async function signOut(): Promise<void> {
  await fetch("/api/session", { method: "DELETE", credentials: "same-origin" }).catch(() => undefined);
  window.dispatchEvent(new Event("verify:session"));
}
