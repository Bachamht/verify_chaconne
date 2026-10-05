"use client";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { MAIN_SITE_URL } from "@/lib/productSwitch";
import { NAV_TOOLS } from "@/lib/nav";
import { LogoMark, Wordmark } from "@/components/Logo";
import { StatusLight } from "./TopBarParts";

/** 营销页脚：产品链接 + 工具 + 免责与状态 */
export function MarketingFooter() {
  const { t, locale } = useI18n();
  const zh = locale === "zh";
  return (
    <footer className="ch-marketing-footer mt-auto border-t border-line/70">
      <div className="mx-auto flex max-w-320 flex-col gap-12 px-4 pb-7 pt-12 sm:px-7 sm:pt-16 lg:px-8">
        <div className="grid gap-10 md:grid-cols-2 md:gap-16">
          <div className="space-y-5">
            <Link href="/" className="ch-brand inline-flex items-center gap-2.5 text-brand-300" aria-label={zh ? "首页" : "Home"}><LogoMark size={28} /><Wordmark /></Link>
            <p className="max-w-xs text-sm leading-7 text-fg-2">{zh ? "把策略交给 Agent，把边界留在自己手中。" : "Give your agent a strategy. Keep control of its boundaries."}</p>
            <p className="font-mono text-xs tracking-wide text-fg-3">{zh ? "基于 X Layer 构建" : "Built on X Layer"}</p>
          </div>
          <nav className="grid grid-cols-2 gap-8 text-sm" aria-label={zh ? "产品与资源" : "Product & resources"}>
            <div className="space-y-4">
              <h2 className="text-xs font-medium tracking-wide text-fg-3">{zh ? "产品" : "Product"}</h2>
              <div className="flex flex-col items-start gap-3">
                <Link className="text-fg-2 transition-colors hover:text-fg-1" href="/start">{zh ? "开始体验" : "Get started"}</Link>
                <Link className="text-fg-2 transition-colors hover:text-fg-1" href="/agent">{zh ? "工作区" : "Workspace"}</Link>
                <a className="inline-flex items-center gap-1 text-fg-2 transition-colors hover:text-fg-1" href={MAIN_SITE_URL}>{zh ? "行情比价" : "Markets"}<ArrowUpRight className="size-3.5" aria-hidden="true" /></a>
              </div>
            </div>
            <div className="space-y-4">
              <h2 className="text-xs font-medium tracking-wide text-fg-3">{zh ? "资源" : "Resources"}</h2>
              <div className="flex flex-col items-start gap-3">
                <Link className="text-fg-2 transition-colors hover:text-fg-1" href="/developers">{zh ? "开发者" : "Developers"}</Link>
                {NAV_TOOLS.map((n) => <Link key={n.href} className="text-fg-2 transition-colors hover:text-fg-1" href={n.href}>{n.label[locale]}</Link>)}
              </div>
            </div>
          </nav>
        </div>
        <div className="flex flex-col gap-5 border-t border-line/70 pt-6 text-xs text-fg-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="max-w-2xl space-y-2 leading-5">
            <p>{t("disclaimer")}</p>
            <p>{t("footer_line")} Chaconne · {t("footer_not_official")}</p>
          </div>
          <div className="flex shrink-0 flex-wrap items-center gap-2">
            <StatusLight />
          </div>
        </div>
      </div>
    </footer>
  );
}
