"use client";
/**
 * v8 钱包门：未连接钱包时解释工作区入口，连接与登录逻辑保持独立。
 * 文案：钱包地址就是账户；第一次读写记录要签一条登录消息，不是交易、不花钱。中文不用破折号（走查 10/3）。
 */
import Link from "next/link";
import { ArrowRight, Eye, ListChecks, SlidersHorizontal, Wallet } from "lucide-react";
import { AsyncButton } from "@/components/kit/AsyncButton";
import { EmptyState } from "@/components/kit/FourStates";
import { useI18n } from "@/lib/i18n";
import { walletErrorText } from "@/lib/i18n.execute";
import { useWalletStatus } from "@/lib/useWalletStatus";
import { useConnect } from "./useConnect";

export function WalletGateV8({ title, description, compact = false }: { title?: string; description?: string; compact?: boolean }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const status = useWalletStatus();
  const { busy, error, connect } = useConnect();
  const err = error ? walletErrorText(error, locale) : null;
  const name = status.walletName;
  const heading = title ?? (zh ? "先连接钱包" : "Connect a wallet first");
  const detail = description ?? (zh ? "钱包就是你的账户。任务、观察、核验和记录都和它绑定。签一次，30 天内都能访问。" : "Your wallet is your account. Tasks, observations, verifications, and records stay linked to it. Sign once to access them for 30 days.");
  const connectAction = (
    <AsyncButton
      className={compact ? undefined : "h-11 w-full px-5 sm:w-auto"}
      pending={busy}
      pendingLabel={name ? (zh ? `在 ${name} 里确认…` : `Confirm in ${name}…`) : (zh ? "连接中…" : "Connecting…")}
      onClick={() => void connect()}
    >
      <Wallet aria-hidden="true" />{zh ? "连接钱包" : "Connect wallet"}
    </AsyncButton>
  );
  if (compact) return (
    <div className="mx-auto max-w-xl">
      <EmptyState size="sm" art={<Wallet className="size-7 text-fg-3" strokeWidth={1.5} aria-hidden="true" />} title={heading} description={detail} action={connectAction} />
      {err ? <p className="mt-3 text-center text-sm text-bad" role="alert">{err}</p> : null}
    </div>
  );
  return (
    <section className="ch-wallet-gate mx-auto my-3 max-w-5xl overflow-hidden rounded-lg border border-line bg-surface-1 sm:my-8">
      <div className="grid min-w-0 lg:grid-cols-5">
        <div className="min-w-0 px-6 py-9 sm:px-10 sm:py-12 lg:col-span-3 lg:py-14">
          <div className="mb-8 flex size-12 items-center justify-center rounded-lg border border-line-strong bg-surface-2 text-brand-300"><Wallet className="size-6" strokeWidth={1.5} aria-hidden="true" /></div>
          <p className="mb-3 text-xs tracking-wide text-fg-3">{zh ? "你的 Agent 工作区" : "Your agent workspace"}</p>
          <h1 className="text-kpi font-medium tracking-tight text-fg-1">{heading}</h1>
          <p className="mt-5 max-w-lg text-sm leading-7 text-fg-2">{detail}</p>
          <div className="mt-8 flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-center sm:gap-5">
            {connectAction}
            <Link href="/start" className="inline-flex min-h-11 items-center justify-center gap-2 text-sm text-fg-2 transition-colors hover:text-fg-1 sm:justify-start">{zh ? "先了解如何开始" : "See how to get started"}<ArrowRight className="size-4" aria-hidden="true" /></Link>
          </div>
          {err ? <p className="mt-4 text-sm text-bad" role="alert">{err}</p> : null}
        </div>
        <div className="min-w-0 border-t border-line/80 bg-surface-0/50 px-6 py-8 sm:px-10 lg:col-span-2 lg:border-t-0 lg:border-l lg:px-8 lg:py-12">
          <p className="mb-7 text-xs tracking-wide text-fg-3">{zh ? "从一个目标开始" : "Start with a goal"}</p>
          <ol className="space-y-7">
            {[
              { icon: ListChecks, title: zh ? "交代你的策略" : "Describe your strategy", body: zh ? "说清关注什么，以及希望 Agent 如何判断。" : "Tell your agent what to watch and how you want it to think." },
              { icon: Eye, title: zh ? "先观察它的判断" : "Observe its decisions", body: zh ? "从观察模式开始，看看每一步背后的理由。" : "Start in observation mode and review the reasoning behind each step." },
              { icon: SlidersHorizontal, title: zh ? "确认执行授权" : "Review its authorization", body: zh ? "真实运行前，核对资产、预算和期限，再逐项签名。" : "Before going live, review the assets, budget and duration, then sign each authorization." },
            ].map(({ icon: Icon, title: stepTitle, body }, i) => (
              <li key={i} className="flex gap-3.5">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-md border border-line/80 bg-surface-1 text-fg-2"><Icon className="size-4" strokeWidth={1.5} aria-hidden="true" /></span>
                <div className="min-w-0 pt-0.5"><h2 className="text-sm font-medium text-fg-1">{stepTitle}</h2><p className="mt-2 text-xs leading-6 text-fg-3">{body}</p></div>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
