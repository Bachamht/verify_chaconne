"use client";
import Link from "next/link";
import { useI18n } from "@/lib/i18n";

export function Footer() {
  const { t } = useI18n();
  return (
    <footer className="border-t border-neutral-800 px-4 py-6 text-center text-xs text-neutral-500">
      <p>{t("disclaimer")}</p>
      <p className="mt-1">
        {t("footer_line")} <a className="underline" href="https://chaconne.xyz" target="_blank" rel="noreferrer">Chaconne</a> · {t("footer_not_official")}
      </p>
      <p className="mt-1 space-x-3">
        <Link className="underline" href="/developers">{t("nav_dev")}</Link>
        <Link className="underline" href="/replay/AAPLx">{t("replay_h")}</Link>
        <Link className="underline" href="/me">{t("nav_me")}</Link>
        <Link className="underline" href="/verify-bundle">{t("nav_verify_bundle")}</Link>
      </p>
    </footer>
  );
}
