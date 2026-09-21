"use client";
/** 头部（V-14 / V-10）：桌面一行；手机折叠成「菜单」；显示已连接钱包与「我的任务」入口。钱包逻辑只用 lib/wallet 现有导出。 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { MAIN_SITE_URL } from "@/lib/productSwitch";
import { api, type AssetsResponse } from "@/lib/api";
import { CHAIN_ID, connect, injected, short } from "@/lib/wallet";

export function ModeBadge() {
  const [mode, setMode] = useState<"LIVE" | "FIXTURE" | "…">("…");
  useEffect(() => {
    api<AssetsResponse>("GET", "v1/assets")
      .then((r) => setMode(r.status === 200 ? r.data.evidenceMode : "…"))
      .catch(() => setMode("…"));
  }, []);
  const cls = mode === "LIVE" ? "bg-ok/15 text-ok border-ok/40" : mode === "FIXTURE" ? "bg-warn/15 text-warn border-warn/40" : "bg-neutral-800 text-neutral-400 border-neutral-700";
  return <span className={`mono rounded-md border px-2 py-0.5 text-xs font-bold ${cls}`}>{mode}</span>;
}

/** 只读取已授权账户（eth_accounts 不弹窗）；点击才 connect */
function WalletStatus({ compact }: { compact?: boolean }) {
  const { t } = useI18n();
  const [account, setAccount] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const eth = injected();
    if (!eth) return;
    eth
      .request({ method: "eth_accounts" })
      .then((a) => {
        const list = a as string[];
        if (list?.[0]) setAccount(list[0]);
      })
      .catch(() => undefined);
    const onChange = (accs: unknown) => setAccount(Array.isArray(accs) && accs[0] ? String(accs[0]) : null);
    const evented = eth as unknown as { on?: (ev: string, fn: (x: unknown) => void) => void; removeListener?: (ev: string, fn: (x: unknown) => void) => void };
    evented.on?.("accountsChanged", onChange);
    return () => evented.removeListener?.("accountsChanged", onChange);
  }, []);
  if (account) return <span className="mono whitespace-nowrap rounded-md border border-ok/40 px-2 py-0.5 text-xs text-ok" title={account}>{short(account)}</span>;
  return (
    <button
      className="btn-ghost whitespace-nowrap px-2.5 py-1 text-sm"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        connect()
          .then(setAccount)
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
  const navLink = (n: (typeof NAV)[number], extra = "") => (
    <Link key={n.href} href={n.href} className={`px-2.5 py-1 text-sm whitespace-nowrap ${pathname === n.href ? "btn" : "btn-ghost"} ${extra}`} aria-current={pathname === n.href ? "page" : undefined}>
      {t(n.key)}
    </Link>
  );
  return (
    <header className="sticky top-0 z-10 border-b border-neutral-800 bg-neutral-950/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-2">
        <Link href="/" className="flex shrink-0 items-center gap-2 whitespace-nowrap font-bold tracking-tight">
          <span className="inline-block h-6 w-6 shrink-0 rounded-md bg-brand" aria-hidden />
          <span>{t("brand")}</span>
        </Link>
        {/* 产品切换（两站同款）：Verify ↔ 主站 */}
        <div className="hidden shrink-0 items-center rounded-lg border border-neutral-800 bg-neutral-900/60 p-0.5 text-[11px] lg:flex" title={t("product_switch_hint")}>
          <a href={MAIN_SITE_URL} className="rounded-md px-2 py-1 text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100" rel="noopener">
            {t("product_main")} ↗
          </a>
          <span className="rounded-md bg-brand/20 px-2 py-1 font-semibold text-brand">{t("product_verify")}</span>
        </div>
        <ModeBadge />
        <span className="mono hidden whitespace-nowrap rounded-md border border-neutral-700 px-2 py-0.5 text-xs text-neutral-300 min-[1400px]:inline">{CHAIN_ID === 196 ? "X Layer · 196" : `X Layer Testnet · ${CHAIN_ID}`}</span>
        {/* 桌面：一行 */}
        <nav className="ml-auto hidden items-center gap-1.5 lg:flex">
          {NAV.map((n) => navLink(n))}
          <span className="mx-1 h-5 w-px bg-neutral-800" aria-hidden />
          <WalletStatus />
          <button className="btn-ghost whitespace-nowrap px-2.5 py-1 text-sm" onClick={() => setLocale(locale === "en" ? "zh" : "en")} aria-label="language">
            {locale === "en" ? "中文" : "EN"}
          </button>
          <button className={`whitespace-nowrap px-2.5 py-1 text-sm ${demo ? "btn" : "btn-ghost"}`} onClick={() => setDemo(!demo)} title={t("demo_mode")}>
            {t("demo_short")}
          </button>
        </nav>
        {/* 手机：钱包 + 菜单按钮 */}
        <div className="ml-auto flex shrink-0 items-center gap-2 lg:hidden">
          <WalletStatus compact />
          <button className="btn-ghost whitespace-nowrap px-2.5 py-1 text-sm" aria-expanded={open} aria-controls="mobile-nav" onClick={() => setOpen(!open)}>
            {open ? t("header_close") : t("header_menu")}
          </button>
        </div>
      </div>
      {open && (
        <nav id="mobile-nav" className="border-t border-neutral-800 px-4 py-3 lg:hidden">
          <a href={MAIN_SITE_URL} rel="noopener" className="btn-ghost mb-2 flex w-full items-center justify-between px-3 py-2 text-sm">
            <span>{t("product_main")}</span>
            <span aria-hidden>↗</span>
          </a>
          <div className="grid grid-cols-2 gap-2">
            {NAV.map((n) => navLink(n, "justify-center"))}
            <button className="btn-ghost px-2.5 py-1 text-sm" onClick={() => setLocale(locale === "en" ? "zh" : "en")}>
              {locale === "en" ? "中文" : "EN"}
            </button>
            <button className={`px-2.5 py-1 text-sm ${demo ? "btn" : "btn-ghost"}`} onClick={() => setDemo(!demo)}>
              {t("demo_mode")}
            </button>
          </div>
          <p className="mono mt-2 text-xs text-neutral-500">{CHAIN_ID === 196 ? "X Layer · 196" : `X Layer Testnet · ${CHAIN_ID}`} · {t("tagline")}</p>
        </nav>
      )}
    </header>
  );
}
