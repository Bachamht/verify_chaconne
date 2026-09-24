"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, ChevronDown, Menu, X } from "lucide-react";
import { useI18n, type Key } from "@/lib/i18n";
import { MAIN_SITE_URL } from "@/lib/productSwitch";
import { api, type AssetsResponse } from "@/lib/api";
import { CHAIN_ID, connect, short } from "@/lib/wallet";
import { useAccount } from "@/lib/useAccount";
import { LogoMark, Wordmark } from "./Logo";

export function ModeBadge() {
  const [mode, setMode] = useState<"LIVE" | "FIXTURE" | "…">("…");
  useEffect(() => {
    api<AssetsResponse>("GET", "v1/assets")
      .then((r) => setMode(r.status === 200 ? r.data.evidenceMode : "…"))
      .catch(() => setMode("…"));
  }, []);
  const cls = mode === "LIVE" ? "bg-ok/12 text-ok" : mode === "FIXTURE" ? "bg-warn/12 text-warn" : "bg-surface-2 text-fg-2";
  return <span className={`mono inline-flex h-5 items-center rounded-full px-2 text-[11px] font-semibold ${cls}`}>{mode}</span>;
}

export function ChainBadge() {
  return <span className="mono inline-flex h-5 items-center rounded-full bg-surface-2 px-2 text-[11px] text-fg-2 ring-1 ring-line">{CHAIN_ID === 196 ? "X Layer · 196" : `X Layer Testnet · ${CHAIN_ID}`}</span>;
}

/** Account state remains wallet-derived; an address is shown only after the wallet grants access. */
function WalletStatus() {
  const { t } = useI18n();
  const account = useAccount();
  const [busy, setBusy] = useState(false);
  if (account) return <span className="verify-wallet-connected mono" title={account}><span aria-hidden="true" />{short(account)}</span>;
  return <button className="btn verify-wallet-button" disabled={busy} onClick={() => {
    setBusy(true);
    connect().catch(() => undefined).finally(() => setBusy(false));
  }}><span className="verify-wallet-full">{busy ? t("wallet_connecting") : t("connect")}</span><span className="verify-wallet-short">{busy ? "…" : t("wallet_short")}</span></button>;
}

/**
 * V-47：全站只有一套导航。页头 = Agent / 任务 / 事件 / 资金 / 日志 / 工具▾ / 开发者；
 * 「工具」下拉收纳旧的核验 / 规划 / 试玩 / 实验 / 验证证据包 / 公开板 / 本机核验记录；
 * 汉堡菜单只在 <900px 出现，内容与页头完全一致；「投屏模式」放到页脚。
 */
type NavItem = { href: string; key: Key };
export const NAV_MAIN: readonly NavItem[] = [
  { href: "/agent", key: "nav_agent" },
  { href: "/agent/tasks", key: "nav_agent_tasks" },
  { href: "/agent/events", key: "nav_agent_events" },
  { href: "/agent/funds", key: "nav_agent_funds" },
  { href: "/agent/journal", key: "nav_agent_journal" },
] as const;
export const NAV_TOOLS: readonly NavItem[] = [
  { href: "/new", key: "nav_new" },
  { href: "/plan", key: "nav_plan" },
  { href: "/play", key: "nav_play" },
  { href: "/agent/lab", key: "nav_agent_lab" },
  { href: "/verify-bundle", key: "nav_verify_bundle" },
  { href: "/live", key: "nav_live" },
  { href: "/me", key: "nav_me" },
] as const;
export const NAV_DEV: NavItem = { href: "/developers", key: "nav_dev" };

export function Header() {
  const { t, locale, setLocale } = useI18n();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [tools, setTools] = useState(false);
  const headerRef = useRef<HTMLElement>(null);
  const toolsRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { setOpen(false); setTools(false); }, [pathname]);
  useEffect(() => {
    if (!open && !tools) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); setTools(false); menuRef.current?.focus(); }
    };
    const closeOutside = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (open && !headerRef.current?.contains(event.target)) setOpen(false);
      if (tools && !toolsRef.current?.contains(event.target)) setTools(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    document.addEventListener("pointerdown", closeOutside);
    return () => { document.removeEventListener("keydown", closeOnEscape); document.removeEventListener("pointerdown", closeOutside); };
  }, [open, tools]);
  const active = (href: string) => (href === "/agent" ? pathname === "/agent" : pathname === href || pathname.startsWith(`${href}/`));
  const toolActive = NAV_TOOLS.some((n) => active(n.href));
  return (
    <header className="verify-header" ref={headerRef}>
      <div className="verify-header-inner">
        <Link href="/" className="verify-brand" aria-label={t("brand")}><LogoMark size={28} /><Wordmark /></Link>
        {/* 回主站的入口：与主站头部那颗「Agent 交易 ↗」胶囊对称，放左上角、紧挨字标 */}
        <a className="verify-switch" href={MAIN_SITE_URL} title={t("product_switch_hint")}>
          {locale === "zh" ? "行情比价" : "Markets"}
          <ArrowUpRight size={12} aria-hidden="true" />
        </a>
        <nav className="verify-desktop-nav" aria-label={locale === "zh" ? "主导航" : "Main navigation"}>
          {NAV_MAIN.map((n) => <Link key={n.href} href={n.href} aria-current={active(n.href) ? "page" : undefined}>{t(n.key)}</Link>)}
          <div className="verify-tools" ref={toolsRef}>
            <button type="button" className="verify-tools-toggle" aria-haspopup="menu" aria-expanded={tools} aria-current={toolActive ? "page" : undefined} onClick={() => setTools((v) => !v)}>{t("nav_tools")}<ChevronDown size={13} aria-hidden="true" /></button>
            {tools && (
              <div className="verify-tools-menu" role="menu" aria-label={t("nav_tools")}>
                {NAV_TOOLS.map((n) => <Link key={n.href} role="menuitem" href={n.href} aria-current={active(n.href) ? "page" : undefined} onClick={() => setTools(false)}>{t(n.key)}</Link>)}
              </div>
            )}
          </div>
          <Link href={NAV_DEV.href} aria-current={active(NAV_DEV.href) ? "page" : undefined}>{t(NAV_DEV.key)}</Link>
        </nav>
        <div className="verify-header-actions">
          <button className="verify-language" aria-label={locale === "en" ? "切换到中文" : "Switch to English"} onClick={() => setLocale(locale === "en" ? "zh" : "en")}>{locale === "en" ? "中文" : "EN"}</button>
          <WalletStatus />
          <button ref={menuRef} className="verify-menu-toggle" aria-expanded={open} aria-controls="verify-browse-nav" aria-label={open ? t("header_close") : t("header_menu")} onClick={() => setOpen(!open)}>{open ? <X size={19} /> : <Menu size={19} />}</button>
        </div>
      </div>
      {open && <nav id="verify-browse-nav" className="verify-browse-nav" aria-label={locale === "zh" ? "导航" : "Navigation"}>
        <div className="verify-browse-inner">
          <div className="verify-browse-links">{[...NAV_MAIN, NAV_DEV].map((n) => <Link key={n.href} href={n.href} aria-current={active(n.href) ? "page" : undefined} onClick={() => setOpen(false)}>{t(n.key)}<ArrowUpRight size={14} aria-hidden="true" /></Link>)}</div>
          <div className="verify-browse-heading"><span>{t("nav_tools")}</span><a href={MAIN_SITE_URL}>{t("product_main")}<ArrowUpRight size={14} aria-hidden="true" /></a></div>
          <div className="verify-browse-links">{NAV_TOOLS.map((n) => <Link key={n.href} href={n.href} aria-current={active(n.href) ? "page" : undefined} onClick={() => setOpen(false)}>{t(n.key)}<ArrowUpRight size={14} aria-hidden="true" /></Link>)}</div>
        </div>
      </nav>}
    </header>
  );
}
