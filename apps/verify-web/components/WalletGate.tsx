"use client";
/**
 * 钱包账户化：钱包地址就是账户。没连接钱包的页面只显示一个「连接钱包」入口，不再提供占位地址、本机记录或手填地址。
 * 连接后 children 拿到地址渲染；断开时自动回到入口。
 */
import { useState, type ReactNode } from "react";
import { Wallet } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { useAccount } from "@/lib/useAccount";
import { connect } from "@/lib/wallet";
import { walletErrorText } from "@/lib/i18n.execute";
import { EmptyState } from "@/components/ui";

/** children 可以是节点（服务端组件里用）或 (account) => 节点（客户端组件里要拿地址时用） */
export function WalletGate({ children, title, description, compact = false }: { children: ReactNode | ((account: string) => ReactNode); title?: string; description?: string; compact?: boolean }) {
  const { locale, t } = useI18n();
  const zh = locale === "zh";
  const account = useAccount();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (account) return <>{typeof children === "function" ? children(account) : children}</>;
  return (
    <div>
      <EmptyState
        compact={compact}
        icon={<Wallet size={28} strokeWidth={1.5} />}
        title={title ?? (zh ? "先连接钱包" : "Connect a wallet first")}
        description={description ?? (zh ? "钱包地址就是你的账户：任务、模拟、核验与记录都跟着它走。第一次读写记录时会请你签一条登录消息（30 天有效）——不是交易，不花钱。" : "Your wallet address is your account: tasks, simulations, verifications and records all follow it. The first time you read or write records you sign one sign-in message (valid 30 days); it is not a transaction and costs nothing.")}
        primary={{ label: busy ? t("wallet_connecting") : t("connect"), onClick: () => { setBusy(true); setErr(null); connect().catch((e: unknown) => setErr(walletErrorText(e, locale))).finally(() => setBusy(false)); } }}
      />
      {err && <p className="mt-3 text-center text-sm text-bad" role="alert">{err}</p>}
    </div>
  );
}
