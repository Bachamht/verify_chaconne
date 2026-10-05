"use client";
/**
 * v8 钱包选择框 + 钱包请求状态条（与 components/WalletChooser.tsx 同一事件协议，只换 kit 外观）：
 * 多个注入钱包时列出全部、OKX Wallet 标「推荐」；请求进行中显示「请在 <钱包名> 里确认」，60 s 无响应给排查与更换钱包。
 */
import { useEffect, useState } from "react";
import { Wallet } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useI18n } from "@/lib/i18n";
import { tx } from "@/lib/i18n.execute";
import { useWalletStatus } from "@/lib/useWalletStatus";
import { forgetWallet, isRecommended, selectWallet, type WalletProviderInfo } from "@/lib/wallet";
import { ToneTag } from "@/components/kit/StatusBadge";

type Req = { wallets: WalletProviderInfo[]; resolve: (rdns: string | null) => void };

export default function WalletChooserV8() {
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
      <Dialog open={req !== null} onOpenChange={(o) => { if (!o) pick(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{zh ? "选择钱包" : "Choose a wallet"}</DialogTitle>
            <DialogDescription>{zh ? "检测到多个钱包。X Layer 上推荐 OKX Wallet；你的选择会被记住，之后可在页头钱包菜单里「更换钱包」。" : "Several wallets are installed. OKX Wallet is recommended on X Layer. Your choice is remembered; change it later from the wallet menu in the header."}</DialogDescription>
          </DialogHeader>
          <ul className="flex flex-col gap-2">
            {req?.wallets.map((w) => (
              <li key={w.rdns}>
                <button type="button" onClick={() => pick(w.rdns)} className="flex w-full items-center gap-3 rounded-md border border-line-strong bg-surface-2 px-3 py-2.5 text-left hover:border-brand-400">
                  {w.icon ? <img src={w.icon} alt="" className="size-6 rounded-sm" /> : <Wallet className="size-6 text-fg-3" aria-hidden="true" />}
                  <span className="min-w-0 flex-1 truncate text-sm text-fg-1">{w.name}</span>
                  {isRecommended(w.rdns) ? <ToneTag tone="ok">{zh ? "推荐" : "Recommended"}</ToneTag> : null}
                </button>
              </li>
            ))}
          </ul>
        </DialogContent>
      </Dialog>
      {status.status !== "idle" && (
        <div className="fixed bottom-4 left-1/2 z-70 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 rounded-lg border border-line-strong bg-popover px-4 py-3 text-sm shadow-pop" role="status" aria-live="polite">
          <p className="text-fg-1"><span className="mr-2 text-xs text-fg-3">{phaseText}</span>{confirmLine}</p>
          {status.status === "slow" && (
            <div className="mt-2 flex flex-col gap-2">
              <p className="text-warn">{tx(locale, "wallet_no_popup")}</p>
              <div className="flex flex-wrap gap-2">
                {status.cancel ? <Button variant="outline" size="sm" onClick={() => status.cancel?.()}>{tx(locale, "wallet_cancel_wait")}</Button> : null}
                <Button variant="outline" size="sm" onClick={() => { status.cancel?.(); forgetWallet(); }}>{tx(locale, "wallet_change")}</Button>
              </div>
              <p className="text-xs text-fg-3">{tx(locale, "wallet_cancel_note")}</p>
            </div>
          )}
        </div>
      )}
    </>
  );
}
