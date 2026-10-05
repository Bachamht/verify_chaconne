"use client";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { CommandPalette } from "@/components/kit/CommandPalette";
import { useI18n } from "@/lib/i18n";
import { AppSidebar } from "./AppSidebar";
import { LanguageToggle, StatusLight } from "./TopBarParts";
import WalletButton from "./WalletButton";

/**
 * 工作区壳：独立的低对比导航区与宽内容区，保留命令面板和钱包状态。
 * 1024–1280 默认折叠侧栏，避免挤压内容。
 */
export function AppShell({ children }: { children: ReactNode }) {
  const { locale } = useI18n();
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (window.innerWidth < 1280) setOpen(false);
  }, []);
  return (
    <SidebarProvider open={open} onOpenChange={setOpen} className="ch-app-shell">
      <AppSidebar />
      <SidebarInset className="min-w-0 bg-background">
        <header className="ch-app-header sticky top-0 z-30 flex h-16 shrink-0 items-center gap-2 border-b border-line/60 bg-background/95 px-3 backdrop-blur-xl sm:px-6">
          <SidebarTrigger aria-label={locale === "zh" ? "展开或收起侧栏" : "Toggle sidebar"} />
          <Separator orientation="vertical" className="mx-1 h-4 opacity-60" />
          <CommandPalette className="w-9 justify-center border-transparent bg-transparent text-fg-3 hover:bg-surface-2 md:w-56 md:justify-start" />
          <div className="ml-auto flex items-center gap-1 sm:gap-2">
            <StatusLight />
            <LanguageToggle />
            <WalletButton />
          </div>
        </header>
        <div id="main-content" tabIndex={-1} className="ch-app-content mx-auto w-full max-w-320 min-w-0 px-4 py-7 outline-none sm:px-7 sm:py-9 xl:px-10">
          {children}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
