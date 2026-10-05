"use client";
/**
 * 已连接钱包（只读 eth_accounts，不弹窗）：头部、执行页钱包卡、新建/规划/模拟表单共用同一份状态（UV-04 / V-37）。
 * 本站「断开连接」后（lib/disconnect）一律当作没连接，直到下一次 connect。
 * 挂载时等 EIP-6963 announce 后静默恢复（V-36：刷新不掉线）；钱包切换 / 换钱包后重新订阅当前 provider 的 accountsChanged。
 */
import { useEffect, useState } from "react";
import { injected, restoreConnection } from "./wallet";
import { isDisconnected } from "./disconnect";

type Evented = { on?: (ev: string, fn: (x: unknown) => void) => void; removeListener?: (ev: string, fn: (x: unknown) => void) => void };

export function useAccount(): string | null {
  return useAccountState().account;
}

/** 同上，另给 ready：第一次静默恢复（eth_accounts）完成前为 false，门禁页据此先显示骨架而不是「连接钱包」 */
export function useAccountState(): { account: string | null; ready: boolean } {
  const [account, setAccount] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    let subscribed: Evented | null = null;
    const onChange = (accs: unknown) => {
      if (alive) setAccount(!isDisconnected() && Array.isArray(accs) && accs[0] ? String(accs[0]) : null);
    };
    const subscribe = () => {
      const eth = injected() as unknown as Evented | null;
      if (eth === subscribed) return;
      subscribed?.removeListener?.("accountsChanged", onChange);
      subscribed = eth;
      eth?.on?.("accountsChanged", onChange);
    };
    const read = () => {
      // 用户在本站点过「断开连接」：下次 connect 之前一律当作没连接
      if (isDisconnected()) {
        setAccount(null);
        setReady(true);
        return;
      }
      void restoreConnection().then((a) => {
        if (!alive) return;
        setAccount(a);
        setReady(true);
        subscribe();
      });
    };
    read();
    // connect() / 换钱包后 lib/wallet 会发状态事件：重新读一次并重新订阅
    window.addEventListener("verify:wallet-status", read);
    window.addEventListener("verify:wallets-changed", read);
    return () => {
      alive = false;
      subscribed?.removeListener?.("accountsChanged", onChange);
      window.removeEventListener("verify:wallet-status", read);
      window.removeEventListener("verify:wallets-changed", read);
    };
  }, []);
  return { account, ready };
}
