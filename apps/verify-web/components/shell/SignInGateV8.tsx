"use client";
/**
 * v8 登录门：钱包已连上，但还没签网站登录消息。显式给一步「签登录消息」，签完才让页面去取这个钱包的记录。
 * 登录消息只证明你控制这个钱包：不是交易、不花钱、不授权任何东西；会话 30 天有效。
 */
import { useState } from "react";
import { ArrowRight, Check, KeyRound, Wallet } from "lucide-react";
import { AsyncButton } from "@/components/kit/AsyncButton";
import { useI18n } from "@/lib/i18n";
import { walletErrorText } from "@/lib/i18n.execute";
import { middleTruncate } from "@/lib/numbers";
import { signIn } from "@/lib/session";

export function SignInGateV8({ account }: { account: string }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function go() {
    setBusy(true);
    setErr(null);
    try {
      const ok = await signIn(account as `0x${string}`);
      if (!ok) setErr(zh ? "登录没有完成，可以再试一次。" : "Sign-in did not complete; try again.");
    } catch (e) {
      setErr(walletErrorText(e, locale));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="ch-signin-gate mx-auto my-6 max-w-2xl overflow-hidden rounded-lg border border-line bg-surface-1 sm:my-12" aria-labelledby="signin-heading">
      <div className="border-b border-line/70 px-6 py-5 sm:px-10">
        <div className="flex flex-wrap items-center gap-3 text-xs text-fg-2">
          <span className="flex items-center gap-2"><Wallet className="size-4 text-fg-3" strokeWidth={1.5} aria-hidden="true" /><span className="font-mono">{middleTruncate(account)}</span></span>
          <span className="ml-auto flex items-center gap-1.5 text-ok"><Check className="size-3.5" aria-hidden="true" />{zh ? "钱包已连接" : "Wallet connected"}</span>
        </div>
      </div>
      <div className="px-6 py-9 sm:px-10 sm:py-11">
        <div className="mb-7 flex size-12 items-center justify-center rounded-lg border border-line-strong bg-surface-2 text-brand-300"><KeyRound className="size-6" strokeWidth={1.5} aria-hidden="true" /></div>
        <p className="mb-3 text-xs tracking-wide text-fg-3">{zh ? "进入你的工作区" : "Your workspace awaits"}</p>
        <h1 id="signin-heading" className="text-kpi font-medium tracking-tight text-fg-1">{zh ? "签一条登录消息" : "Sign the login message"}</h1>
        <p className="mt-4 max-w-lg text-sm leading-7 text-fg-2">{zh
          ? "在查看和管理任务前，请在钱包里确认是你本人。这条消息只用于登录，签完就能回到你的工作区。"
          : "Confirm that this wallet is yours before viewing and managing your tasks. This message signs you in and opens your workspace."}</p>
        <AsyncButton className="mt-7 h-11 w-full justify-between px-4 sm:w-auto sm:min-w-52 sm:gap-6" pending={busy} pendingLabel={zh ? "请在钱包里确认…" : "Confirm in your wallet…"} onClick={() => void go()}>{zh ? "签登录消息" : "Sign the login message"}<ArrowRight className="size-4" aria-hidden="true" /></AsyncButton>
        {err ? <p className="mt-4 text-sm text-bad" role="alert">{err}</p> : null}
        <p className="mt-5 text-xs leading-5 text-fg-3">{zh ? "登录会话有效期为 30 天。" : "Your sign-in stays valid for 30 days."}</p>
      </div>
    </section>
  );
}
