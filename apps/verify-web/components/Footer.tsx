"use client";

import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { MAIN_SITE_URL } from "@/lib/productSwitch";
import { ChainBadge, ModeBadge } from "./Header";
import { LogoMark, Wordmark } from "./Logo";

export function Footer() {
  const { t, demo, setDemo } = useI18n();
  return (
    <footer className="verify-footer">
      <div className="verify-footer-inner">
        <div className="verify-footer-top">
          <Link href="/" className="verify-brand" aria-label={t("brand")}><LogoMark size={27} /><Wordmark /></Link>
          <nav className="verify-footer-links" aria-label="Chaconne Agent resources">
            <Link href="/developers">{t("nav_dev")}</Link>
            <Link href="/verify-bundle">{t("nav_verify_bundle")}</Link>
            <Link href="/replay/AAPLx">{t("replay_h")}</Link>
            <Link href="/me">{t("nav_me")}</Link>
            <a href={MAIN_SITE_URL}>{t("product_main")}<ArrowUpRight size={12} aria-hidden="true" /></a>
          </nav>
        </div>
        <div className="verify-footer-bottom">
          <div className="verify-footer-legal"><p>{t("disclaimer")}</p><p>{t("footer_line")} Chaconne · {t("footer_not_official")}</p></div>
          <div className="verify-footer-status">
            {/* V-46 / V-47：「投屏模式」从导航挪到页脚，并说明它做什么 */}
            <button type="button" className="verify-demo-toggle" aria-pressed={demo} title={t("demo_mode_hint")} onClick={() => setDemo(!demo)}>{t("demo_mode")} <span className={demo ? "text-brand-300" : "text-fg-3"}>{demo ? "ON" : "OFF"}</span></button>
            <span className="verify-demo-hint">{t("demo_mode_hint")}</span>
            <span>{t("footer_mode")}</span><ModeBadge /><span>{t("footer_network")}</span><ChainBadge />
          </div>
        </div>
      </div>
    </footer>
  );
}
