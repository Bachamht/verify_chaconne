"use client";
/**
 * 头部（UI 设计评审 UV-01/02/03）：与正文同一版心（max-w-5xl）、子项可收缩不再撑出横向滚动；
 * 波形标 + 字标；导航纯文字、当前页下划线；实心紫只留主要操作；LIVE / 链徽章只在 ≥2xl 显示，其余在页脚。
 * 钱包状态与各表单共用 useAccount（UV-04）。
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Menu, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
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

/** 只读取已授权账户（不弹窗）；点击才 connect */
function WalletStatus({ compact }: { compact?: boolean }) {
  const { t } = useI18n();
  const account = useAccount();
  const [busy, setBusy] = useState(false);
  if (account) return <span className="mono inline-flex h-8 items-center whitespace-nowrap rounded-md bg-ok/12 px-2.5 text-xs text-ok" title={account}>{short(account)}</span>;
  return (
    <button
      className="btn h-8 px-3 text-xs"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        connect()
          .catch(() => undefined)
          .finally(() => setBusy(false));
      }}
    >
      {busy ? t("wallet_connecting") : compact ? t("wallet_short") : t("connect")}
    </button>
  );
}

const NAV: Array<{ href: string; key: "nav_new" | "nav_plan" | "nav_play" | "nav_live" | "nav_me" | "nav_dev" }> = [
  { href: "/new", key: "nav_new" },
  { href: "/plan", key: "nav_plan" },
  { href: "/play", key: "nav_play" },
  { href: "/live", key: "nav_live" },
  { href: "/me", key: "nav_me" },
  { href: "/developers", key: "nav_dev" },
];

export function Header() {
  const { t, locale, setLocale, demo, setDemo } = useI18n();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [pathname]);
  const active = (href: string) => pathname === href || (href !== "/" && pathname.startsWith(`${href}/`));
  const textLink = (n: (typeof NAV)[number]) => (
    <Link
      key={n.href}
      href={n.href}
      aria-current={active(n.href) ? "page" : undefined}
      className={`relative whitespace-nowrap px-2 py-1.5 text-sm transition-colors after:absolute after:inset-x-2 after:-bottom-[9px] after:h-0.5 after:rounded-full after:bg-brand-400 ${active(n.href) ? "text-fg-1 after:opacity-100" : "text-fg-2 after:opacity-0 hover:text-fg-1"}`}
    >
      {t(n.key)}
    </Link>
  );
  const smallGhost = "btn-ghost h-8 px-2.5 text-xs";
  return (
    <header className="sticky top-0 z-10 border-b border-line bg-surface-0/90 backdrop-blur">
      <div className="mx-auto flex min-w-0 max-w-5xl items-center gap-3 px-4 py-2.5">
        <Link href="/" className="flex shrink-0 items-center gap-2 text-brand-400" aria-label={t("brand")}>
          <LogoMark size={26} />
          <Wordmark />
        </Link>
        {/* 产品切换（两站同款）：Verify ↔ 主站 */}
        <div className="hidden shrink-0 items-center rounded-md bg-surface-2 p-0.5 text-[11px] ring-1 ring-line lg:flex" title={t("product_switch_hint")}>
          <a href={MAIN_SITE_URL} className="rounded-sm px-2 py-1 text-fg-2 hover:bg-neutral-800 hover:text-fg-1" rel="noopener">
            {t("product_main")} ↗
          </a>
          <span className="rounded-sm bg-brand-950/70 px-2 py-1 font-semibold text-brand-300">{t("product_verify")}</span>
        </div>
        <div className="hidden items-center gap-1.5 2xl:flex">
          <ModeBadge />
          <ChainBadge />
        </div>
        {/* 桌面：纯文字导航 */}
        <nav className="ml-auto hidden min-w-0 items-center gap-1 lg:flex">
          {NAV.map(textLink)}
          <span className="mx-2 h-5 w-px bg-line" aria-hidden />
          <WalletStatus />
          <button className={smallGhost} onClick={() => setLocale(locale === "en" ? "zh" : "en")} aria-label="language">
            {locale === "en" ? "中文" : "EN"}
          </button>
          <button className={`${smallGhost} ${demo ? "ring-brand-400 text-brand-300" : ""}`} aria-pressed={demo} onClick={() => setDemo(!demo)} title={t("demo_mode")}>
            {t("demo_short")}
          </button>
        </nav>
        {/* 手机：钱包 + 菜单按钮 */}
        <div className="ml-auto flex shrink-0 items-center gap-2 lg:hidden">
          <WalletStatus compact />
          <button className="btn-ghost h-9 w-9 px-0" aria-expanded={open} aria-controls="mobile-nav" aria-label={open ? t("header_close") : t("header_menu")} onClick={() => setOpen(!open)}>
            {open ? <X size={18} /> : <Menu size={18} />}
          </button>
        </div>
      </div>
      {open && (
        <nav id="mobile-nav" className="border-t border-line px-4 py-3 lg:hidden">
          <div className="grid grid-cols-2 gap-1">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} aria-current={active(n.href) ? "page" : undefined} className={`rounded-md px-3 py-2.5 text-sm ${active(n.href) ? "bg-brand-950/60 text-brand-200" : "text-fg-1 hover:bg-surface-2"}`}>
                {t(n.key)}
              </Link>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-line pt-2">
            <a href={MAIN_SITE_URL} rel="noopener" className={smallGhost}>
              {t("product_main")} ↗
            </a>
            <button className={smallGhost} onClick={() => setLocale(locale === "en" ? "zh" : "en")}>
              {locale === "en" ? "中文" : "EN"}
            </button>
            <button className={`${smallGhost} ${demo ? "ring-brand-400 text-brand-300" : ""}`} aria-pressed={demo} onClick={() => setDemo(!demo)}>
              {t("demo_mode")}
            </button>
            <span className="ml-auto flex items-center gap-1.5">
              <ModeBadge />
              <ChainBadge />
            </span>
          </div>
        </nav>
      )}
    </header>
  );
}
