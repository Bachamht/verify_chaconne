"use client";
/**
 * 「断开连接」：网页没法替钱包真正断开（eth_accounts 仍会返回已授权的地址），所以本站自己记一个「已断开」标记：
 * 有标记时 useAccount 一律当作没连接；下一次任何 connect()（钱包状态事件 busy + phase=connect）清掉标记。
 * 断开同时退出登录会话、忘掉记住的钱包，并尽量请钱包撤销本站的账户权限（不支持的钱包忽略）。
 * 不改 lib/wallet.ts。
 */
import { forgetWallet, injected, type WalletStatusDetail } from "./wallet";
import { signOut } from "./session";

const KEY = "verify-disconnected";

export function isDisconnected(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

function clearDisconnected(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

if (typeof window !== "undefined") {
  window.addEventListener("verify:wallet-status", (e) => {
    const d = (e as CustomEvent<WalletStatusDetail>).detail;
    if (d?.status === "busy" && d.phase === "connect") clearDisconnected();
  });
}

export async function disconnectWallet(): Promise<void> {
  try {
    localStorage.setItem(KEY, "1");
  } catch {
    /* ignore */
  }
  const eth = injected();
  await eth?.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] }).catch(() => undefined);
  await signOut();
  forgetWallet();
}
