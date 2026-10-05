"use client";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useI18n } from "@/lib/i18n";
import { usesAppShell } from "@/lib/nav";

/** 两种壳各自拆包：首页不加载工作区壳（它带 viem 钱包代码）；服务端照常渲染，不闪 */
const AppShell = dynamic(() => import("./AppShell").then((m) => m.AppShell));
const MarketingShell = dynamic(() => import("./MarketingShell").then((m) => m.MarketingShell));

/** 钱包选择框带 viem：延迟加载（首页不进首屏包） */
const WalletChooserV8 = dynamic(() => import("./WalletChooserV8"), { ssr: false });

/**
 * v8 根：按路径选壳（/agent/* → AppShell，其余 → MarketingShell），挂全局 Toaster / Tooltip / 钱包选择框。
 * 偏离方案 §4.2：开关期间不搬路由组目录，用路径选壳，URL 与旧页面文件都不动（记在 UI-HANDOFF）。
 */
export function V8Root({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "/";
  const { locale } = useI18n();
  return (
    <TooltipProvider delayDuration={300}>
      <a href="#main-content" className="fixed top-2 left-4 z-100 -translate-y-24 rounded-md bg-brand-200 px-4 py-2 text-sm text-surface-0 focus:translate-y-0">
        {locale === "zh" ? "跳到主要内容" : "Skip to content"}
      </a>
      {usesAppShell(pathname) ? <AppShell>{children}</AppShell> : <MarketingShell>{children}</MarketingShell>}
      <Toaster position="bottom-right" />
      <WalletChooserV8 />
    </TooltipProvider>
  );
}
