"use client";
import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { ArrowUpRight, Menu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { useI18n } from "@/lib/i18n";
import { isActive, NAV_MARKETING } from "@/lib/nav";
import { MAIN_SITE_URL } from "@/lib/productSwitch";
import { cn } from "@/lib/utils";
import { LogoMark, Wordmark } from "@/components/Logo";
import { MarketingFooter } from "./MarketingFooter";
import { LanguageToggle } from "./TopBarParts";

/** 钱包按钮带 viem：营销页延迟加载，不进首屏包（D6） */
const WalletButton = dynamic(() => import("./WalletButton"), { ssr: false, loading: () => <span className="inline-block h-8 w-24" aria-hidden="true" /> });

/** 营销壳（/、/start、/developers、/r、/live、/verify-bundle、工具页）：顶栏只留 开始 · 工作区 · 开发者 · 行情比价 ↗ · 语言 / 钱包 */
export function MarketingShell({ children }: { children: ReactNode }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const pathname = usePathname() ?? "";
  const [open, setOpen] = useState(false);
  const isHome = pathname === "/";
  const linkCls = (href: string) => cn("ch-marketing-nav-link inline-flex h-10 items-center whitespace-nowrap rounded-md px-3 text-sm text-fg-2 transition-colors hover:text-fg-1", isActive(pathname, href) && "bg-surface-2/70 text-fg-1");
  return (
    <div className="ch-marketing-shell flex min-h-dvh flex-col">
      <header className="ch-marketing-header sticky top-0 z-30 border-b border-line/60 bg-background/90 backdrop-blur-xl">
        <div className="mx-auto flex h-19 max-w-320 items-center gap-4 px-4 sm:gap-6 sm:px-7 lg:px-8">
          <Link href="/" className="ch-brand flex shrink-0 items-center gap-2.5 text-brand-300" aria-label={zh ? "Chaconne Agent 首页" : "Chaconne Agent home"}>
            <LogoMark size={30} /><Wordmark />
          </Link>
          <nav className="ch-marketing-nav ml-auto hidden items-center gap-1 lg:flex" aria-label={zh ? "主导航" : "Main navigation"}>
            {NAV_MARKETING.map((n) => <Link key={n.href} href={n.href} className={linkCls(n.href)} aria-current={isActive(pathname, n.href) ? "page" : undefined}>{n.label[locale]}</Link>)}
            <a href={MAIN_SITE_URL} className="inline-flex h-10 items-center gap-1 rounded-md px-3 text-sm text-fg-2 transition-colors hover:text-fg-1">{zh ? "行情比价" : "Markets"}<ArrowUpRight className="size-3.5 opacity-60" aria-hidden="true" /></a>
          </nav>
          <div className="ml-auto flex items-center gap-1 sm:gap-2 lg:ml-2 lg:border-l lg:border-line/70 lg:pl-5">
            <LanguageToggle className="h-9" />
            <WalletButton />
            <Sheet open={open} onOpenChange={setOpen}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="lg:hidden" aria-label={zh ? "打开菜单" : "Open menu"}><Menu aria-hidden="true" /></Button>
              </SheetTrigger>
              <SheetContent side="right" className="w-80 max-w-full gap-6 bg-popover">
                <SheetHeader className="border-b border-line/70 px-6 py-7"><SheetTitle className="flex items-center gap-3"><LogoMark size={26} className="text-brand-300" />{zh ? "导航" : "Navigation"}</SheetTitle><SheetDescription className="sr-only">{zh ? "站点导航" : "Site navigation"}</SheetDescription></SheetHeader>
                <nav className="flex flex-col gap-2 px-4" aria-label={zh ? "主导航" : "Main navigation"}>
                  {NAV_MARKETING.map((n) => <Link key={n.href} href={n.href} onClick={() => setOpen(false)} className={cn("flex min-h-12 items-center justify-between rounded-md px-4 text-md text-fg-2 transition-colors hover:bg-surface-2 hover:text-fg-1", isActive(pathname, n.href) && "bg-surface-2 text-fg-1")} aria-current={isActive(pathname, n.href) ? "page" : undefined}>{n.label[locale]}<ArrowUpRight className="size-4 text-fg-3" aria-hidden="true" /></Link>)}
                  <a href={MAIN_SITE_URL} className="mt-3 flex min-h-12 items-center justify-between border-t border-line/70 px-4 pt-3 text-sm text-fg-2">{zh ? "行情比价" : "Markets"}<ArrowUpRight className="size-4" aria-hidden="true" /></a>
                </nav>
              </SheetContent>
            </Sheet>
          </div>
        </div>
      </header>
      <main id="main-content" tabIndex={-1} className={cn("ch-marketing-main mx-auto w-full min-w-0 flex-1 px-4 outline-none sm:px-7 lg:px-8", isHome ? "max-w-320" : "max-w-300 py-8 sm:py-12")}>{children}</main>
      <MarketingFooter />
    </div>
  );
}
