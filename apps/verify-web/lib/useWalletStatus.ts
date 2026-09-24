"use client";
/** 订阅 lib/wallet 的请求状态（busy / slow / idle + 阶段 + 钱包名 + 取消）：全局提示条与执行页钱包卡共用（V-36）。 */
import { useEffect, useState } from "react";
import { walletStatus, type WalletStatusDetail } from "./wallet";

export function useWalletStatus(): WalletStatusDetail {
  const [s, setS] = useState<WalletStatusDetail>({ status: "idle", phase: null, walletName: null, cancel: null });
  useEffect(() => {
    setS(walletStatus());
    const onStatus = (ev: Event) => setS((ev as CustomEvent<WalletStatusDetail>).detail);
    window.addEventListener("verify:wallet-status", onStatus);
    return () => window.removeEventListener("verify:wallet-status", onStatus);
  }, []);
  return s;
}
