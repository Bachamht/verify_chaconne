"use client";
/** X-01：深色双语 404，带返回首页（Next 默认页是白底英文）。 */
import Link from "next/link";
import { useI18n } from "@/lib/i18n";

export default function NotFound() {
  const { t } = useI18n();
  return (
    <div className="mx-auto max-w-xl space-y-4 py-16 text-center">
      <p className="mono text-6xl font-bold text-neutral-700">404</p>
      <h1 className="text-2xl font-bold">{t("nf_h")}</h1>
      <p className="text-sm text-neutral-400">{t("nf_p")}</p>
      <div className="flex flex-wrap justify-center gap-2">
        <Link href="/" className="btn">{t("nf_home")}</Link>
        <Link href="/me" className="btn-ghost">{t("nav_me")}</Link>
      </div>
    </div>
  );
}
