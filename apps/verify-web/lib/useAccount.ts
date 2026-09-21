"use client";
/** 已连接钱包（只读 eth_accounts，不弹窗）：头部、新建/规划/模拟表单共用同一份状态（UV-04）。 */
import { useEffect, useState } from "react";
import { injected } from "./wallet";

type Evented = { on?: (ev: string, fn: (x: unknown) => void) => void; removeListener?: (ev: string, fn: (x: unknown) => void) => void };

export function useAccount(): string | null {
  const [account, setAccount] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const read = () => {
      const eth = injected();
      if (!eth) return;
      eth
        .request({ method: "eth_accounts" })
        .then((a) => {
          const list = a as string[];
          if (alive) setAccount(list?.[0] ? String(list[0]) : null);
        })
        .catch(() => undefined);
    };
    read();
    const onChange = (accs: unknown) => setAccount(Array.isArray(accs) && accs[0] ? String(accs[0]) : null);
    const eth = injected() as unknown as Evented | null;
    eth?.on?.("accountsChanged", onChange);
    // connect() / 换钱包后 lib/wallet 会发状态事件：重新读一次
    window.addEventListener("verify:wallet-status", read);
    window.addEventListener("verify:wallets-changed", read);
    return () => {
      alive = false;
      eth?.removeListener?.("accountsChanged", onChange);
      window.removeEventListener("verify:wallet-status", read);
      window.removeEventListener("verify:wallets-changed", read);
    };
  }, []);
  return account;
}
