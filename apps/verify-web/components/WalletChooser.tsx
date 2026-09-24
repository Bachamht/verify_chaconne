"use client";
/**
 * 全局钱包选择框 + 连接状态提示（V-06 / V-36）。挂在 layout；lib/wallet.ts 的 connect() 通过事件驱动它。
 * 多个注入钱包（EIP-6963）时列出全部，OKX Wallet 排第一标"推荐"；任何钱包请求进行中显示「请在 <钱包名> 弹窗里确认」，
 * 60 s 无响应给「没看到弹窗？」排查提示 + 取消等待 + 更换钱包；执行页钱包卡会显示同一份状态，这里只在其它页面兜底。
 */
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { tx } from "@/lib/i18n.execute";
import { useWalletStatus } from "@/lib/useWalletStatus";
import { forgetWallet, isRecommended, selectWallet, type WalletProviderInfo } from "@/lib/wallet";

type Req = { wallets: WalletProviderInfo[]; resolve: (rdns: string | null) => void };

export function WalletChooser() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const [req, setReq] = useState<Req | null>(null);
  const status = useWalletStatus();

  useEffect(() => {
    const onChoose = (ev: Event) => setReq((ev as CustomEvent<Req>).detail);
    window.addEventListener("verify:choose-wallet", onChoose);
    return () => window.removeEventListener("verify:choose-wallet", onChoose);
  }, []);

  const pick = (rdns: string | null) => {
    if (!req) return;
    if (rdns) selectWallet(rdns);
    req.resolve(rdns);
    setReq(null);
  };
  const phaseText = status.phase ? tx(locale, `phase_${status.phase}` as "phase_connect") : "";
  const confirmLine = status.walletName ? tx(locale, "wallet_confirm_in", { wallet: status.walletName }) : tx(locale, "wallet_confirm_generic");

  return (
    <>
      {req && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/70 p-4 sm:items-center" role="dialog" aria-modal="true" onClick={() => pick(null)}>
          <div className="card w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-1 text-lg font-bold">{zh ? "选择钱包" : "Choose a wallet"}</h2>
            <p className="mb-3 text-sm text-fg-2">{zh ? "检测到多个钱包。X Layer 上推荐 OKX Wallet；你的选择会被记住，可在钱包区「更换钱包」。" : "Several wallets are installed. OKX Wallet is recommended on X Layer; your choice is remembered and can be changed with \"Switch wallet\" in the wallet card."}</p>
            <ul className="space-y-2">
              {req.wallets.map((w) => (
                <li key={w.rdns}>
                  <button className="btn-ghost flex w-full items-center gap-3 px-3 py-2 text-left" onClick={() => pick(w.rdns)}>
                    {w.icon ? <img src={w.icon} alt="" className="h-6 w-6 rounded" /> : <span className="inline-block h-6 w-6 rounded bg-neutral-700" />}
                    <span className="flex-1">{w.name}</span>
                    {isRecommended(w.rdns) && <span className="rounded-md border border-ok/40 px-2 py-0.5 text-xs text-ok">{zh ? "推荐" : "recommended"}</span>}
                    <span className="mono text-xs text-fg-3">{w.rdns}</span>
                  </button>
                </li>
              ))}
            </ul>
            <button className="btn-ghost mt-3 w-full" onClick={() => pick(null)}>{zh ? "取消" : "Cancel"}</button>
          </div>
        </div>
      )}
      {status.status !== "idle" && (
        <div className="fixed bottom-4 left-1/2 z-40 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 rounded-lg border border-line-strong bg-neutral-900 px-4 py-3 text-sm shadow-lg" role="status" aria-live="polite">
          <p>
            <span className="mono mr-2 text-xs text-fg-3">{phaseText}</span>
            {confirmLine}
          </p>
          {status.status === "slow" && (
            <div className="mt-2 space-y-2">
              <p className="text-warn">{tx(locale, "wallet_no_popup")}</p>
              <div className="flex flex-wrap gap-2">
                {status.cancel && <button className="btn-ghost px-3 py-1 text-xs" onClick={() => status.cancel?.()}>{tx(locale, "wallet_cancel_wait")}</button>}
                <button className="btn-ghost px-3 py-1 text-xs" onClick={() => { status.cancel?.(); forgetWallet(); }}>{tx(locale, "wallet_change")}</button>
              </div>
              <p className="text-xs text-fg-3">{tx(locale, "wallet_cancel_note")}</p>
            </div>
          )}
        </div>
      )}
    </>
  );
}
