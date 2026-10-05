"use client";
/**
 * 钱包账户化：钱包地址就是账户。没连接钱包的页面只显示一个「连接钱包」入口，不再提供占位地址、本机记录或手填地址。
 * 连接后 children 拿到地址渲染；断开时自动回到入口。
 */
import { useEffect, useState, type ReactNode } from "react";
import { Wallet } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { useAccountState } from "@/lib/useAccount";
import { connect } from "@/lib/wallet";
import { walletErrorText } from "@/lib/i18n.execute";
import { EmptyState } from "@/components/ui";
import { v7FixtureRequested } from "@/lib/v7";
import { FX_OWNER } from "@/lib/v7fixtures";
import { V8_UI } from "@/lib/v8";
import { WalletGateV8 } from "@/components/shell/WalletGateV8";
import { SignInGateV8 } from "@/components/shell/SignInGateV8";
import { useSessionAddress } from "@/lib/useSession";
import { LoadingBlock } from "@/components/kit/FourStates";

/** children 可以是节点（服务端组件里用）或 (account) => 节点（客户端组件里要拿地址时用） */
export function WalletGate({ children, title, description, compact = false }: { children: ReactNode | ((account: string) => ReactNode); title?: string; description?: string; compact?: boolean }) {
  const { locale, t } = useI18n();
  const zh = locale === "zh";
  const { account, ready } = useAccountState();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** v7 本地预览（NEXT_PUBLIC_V7_UI=1 且 ?v7fixture=1）：用占位地址渲染 fixture 页面，不连钱包、不签名；开关关闭时恒为 false */
  const [fixture, setFixture] = useState(false);
  useEffect(() => { setFixture(v7FixtureRequested(window.location.search)); }, []);
  const who = account ?? (fixture ? FX_OWNER : null);
  const session = useSessionAddress();
  if (who) {
    // v8：钱包连上但还没签网站登录消息时，先给「签登录消息」这一步，页面不提前发 owner 请求（否则每页一串 401）
    if (V8_UI && !fixture) {
      if (!session.checked) return <LoadingBlock rows={4} />;
      if (session.address !== who.toLowerCase()) return <SignInGateV8 account={who} />;
    }
    return <>{typeof children === "function" ? children(who) : children}</>;
  }
  // v8：静默恢复（eth_accounts）完成前不闪「连接钱包」，先给等形骨架
  if (V8_UI) return ready ? <WalletGateV8 title={title} description={description} compact={compact} /> : <LoadingBlock rows={4} />;
  return (
    <div>
      <EmptyState
        compact={compact}
        icon={<Wallet size={28} strokeWidth={1.5} />}
        title={title ?? (zh ? "先连接钱包" : "Connect a wallet first")}
        description={description ?? (zh ? "钱包地址就是你的账户：任务、模拟、核验与记录都跟着它走。第一次读写记录时会请你签一条登录消息（30 天有效），这不是交易，不花钱。" : "Your wallet address is your account: tasks, simulations, verifications and records all follow it. The first time you read or write records you sign one sign-in message (valid 30 days); it is not a transaction and costs nothing.")}
        primary={{ label: busy ? t("wallet_connecting") : t("connect"), onClick: () => { setBusy(true); setErr(null); connect().catch((e: unknown) => setErr(walletErrorText(e, locale))).finally(() => setBusy(false)); } }}
      />
      {err && <p className="mt-3 text-center text-sm text-bad" role="alert">{err}</p>}
    </div>
  );
}
