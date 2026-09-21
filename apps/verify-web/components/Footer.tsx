"use client";
/** 页脚（UV-01 / UV-05）：证据模式与网络徽章常驻这里；body 为 flex 列、main flex-1，页脚永远贴底。 */
import Link from "next/link";
import { useI18n } from "@/lib/i18n";
import { ChainBadge, ModeBadge } from "./Header";

export function Footer() {
  const { t } = useI18n();
  return (
    <footer className="mt-auto border-t border-line px-4 py-6 text-center text-xs text-fg-3">
      <p className="mb-3 flex flex-wrap items-center justify-center gap-2">
        <span>{t("footer_mode")}</span>
        <ModeBadge />
        <span className="ml-2">{t("footer_network")}</span>
        <ChainBadge />
      </p>
      <p>{t("disclaimer")}</p>
      <p className="mt-1">
        {t("footer_line")} <a className="underline hover:text-fg-1" href="https://chaconne.xyz" target="_blank" rel="noreferrer">Chaconne</a> · {t("footer_not_official")}
      </p>
      <p className="mt-1 space-x-3">
        <Link className="underline hover:text-fg-1" href="/developers">{t("nav_dev")}</Link>
        <Link className="underline hover:text-fg-1" href="/replay/AAPLx">{t("replay_h")}</Link>
        <Link className="underline hover:text-fg-1" href="/me">{t("nav_me")}</Link>
        <Link className="underline hover:text-fg-1" href="/verify-bundle">{t("nav_verify_bundle")}</Link>
      </p>
    </footer>
  );
}
