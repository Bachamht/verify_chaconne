"use client";
/**
 * 全局钱包选择框 + 连接状态提示（V-06）。挂在 layout；lib/wallet.ts 的 connect() 通过事件驱动它。
 * 多个注入钱包（EIP-6963）时列出全部，OKX Wallet 排第一标"推荐"；连接中显示"请在钱包里确认"，60 s 无响应给排查提示。
 */
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { isRecommended, selectWallet, type WalletProviderInfo, type WalletStatus } from "@/lib/wallet";

type Req = { wallets: WalletProviderInfo[]; resolve: (rdns: string | null) => void };

export function WalletChooser() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const [req, setReq] = useState<Req | null>(null);
  const [status, setStatus] = useState<WalletStatus>("idle");

  useEffect(() => {
    const onChoose = (ev: Event) => setReq((ev as CustomEvent<Req>).detail);
    const onStatus = (ev: Event) => setStatus((ev as CustomEvent<WalletStatus>).detail);
    window.addEventListener("verify:choose-wallet", onChoose);
    window.addEventListener("verify:wallet-status", onStatus);
    return () => {
      window.removeEventListener("verify:choose-wallet", onChoose);
      window.removeEventListener("verify:wallet-status", onStatus);
    };
  }, []);

  const pick = (rdns: string | null) => {
    if (!req) return;
    if (rdns) selectWallet(rdns);
    req.resolve(rdns);
    setReq(null);
  };

  return (
    <>
      {req && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 sm:items-center" role="dialog" aria-modal="true" onClick={() => pick(null)}>
          <div className="card w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-1 text-lg font-bold">{zh ? "选择钱包" : "Choose a wallet"}</h2>
            <p className="mb-3 text-sm text-neutral-400">{zh ? "检测到多个钱包。X Layer 上推荐 OKX Wallet；你的选择会被记住，可在钱包区更换。" : "Several wallets are installed. OKX Wallet is recommended on X Layer; your choice is remembered and can be changed later."}</p>
            <ul className="space-y-2">
              {req.wallets.map((w) => (
                <li key={w.rdns}>
                  <button className="btn-ghost flex w-full items-center gap-3 px-3 py-2 text-left" onClick={() => pick(w.rdns)}>
                    {w.icon ? <img src={w.icon} alt="" className="h-6 w-6 rounded" /> : <span className="inline-block h-6 w-6 rounded bg-neutral-700" />}
                    <span className="flex-1">{w.name}</span>
                    {isRecommended(w.rdns) && <span className="rounded-md border border-ok/40 px-2 py-0.5 text-xs text-ok">{zh ? "推荐" : "recommended"}</span>}
                    <span className="mono text-xs text-neutral-500">{w.rdns}</span>
                  </button>
                </li>
              ))}
            </ul>
            <button className="btn-ghost mt-3 w-full" onClick={() => pick(null)}>{zh ? "取消" : "Cancel"}</button>
          </div>
        </div>
      )}
      {status !== "idle" && (
        <div className="fixed bottom-4 left-1/2 z-40 -translate-x-1/2 rounded-lg border border-neutral-700 bg-neutral-900 px-4 py-2 text-sm shadow-lg">
          {status === "connecting" ? (zh ? "请在钱包弹窗里确认连接…" : "Confirm the connection in your wallet…") : zh ? "钱包 60 秒没有响应：可能锁着、弹窗被浏览器挡住，或需要在钱包里切换到这个站点。" : "No response from the wallet for 60 s: it may be locked, the popup may be blocked, or the wallet needs you to switch to this site."}
        </div>
      )}
    </>
  );
}
