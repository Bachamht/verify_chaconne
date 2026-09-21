"use client";
import Link from "next/link";
import { useI18n } from "@/lib/i18n";
import { Card } from "@/components/ui";

export default function Home() {
  const { t, locale } = useI18n();
  return (
    <div className="space-y-10">
      <section className="space-y-5 pt-6">
        <h1 className="max-w-3xl text-3xl font-bold leading-tight sm:text-4xl">{t("hero_h")}</h1>
        <p className="max-w-3xl text-lg leading-7 text-fg-1">{t("human_intro")}</p>
        <p className="max-w-3xl text-fg-2">{t("hero_p")}</p>
        <div className="flex flex-wrap gap-3">
          <Link href="/new" className="btn">
            {t("cta_new")}
          </Link>
          <Link href="/developers" className="btn-ghost">
            {t("cta_dev")}
          </Link>
        </div>
      </section>

      <section>
        <h2 className="mb-3 text-xs font-medium uppercase tracking-wide text-fg-3">{t("what_you_get")}</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <Card title={t("feat1_h")}>
            <p className="text-sm text-neutral-300">{t("feat1_p")}</p>
          </Card>
          <Card title={t("feat2_h")}>
            <p className="text-sm text-neutral-300">{t("feat2_p")}</p>
          </Card>
          <Card title={t("feat3_h")}>
            <p className="text-sm text-neutral-300">{t("feat3_p")}</p>
          </Card>
        </div>
      </section>

      <Card title={locale === "zh" ? "一次真实核验长什么样" : "What a real verification looks like"}>
        <ol className="list-decimal space-y-2 pl-5 text-sm text-neutral-300">
          <li>{locale === "zh" ? "选资产（按链+合约）、金额、策略；服务采集 OKX 报价、链上元数据、股票参考价，每条证据带源时间与哈希。" : "Pick asset (chain + contract), amount, policy. The service collects an OKX quote, on-chain token metadata and the stock reference — every piece stamped with source time and a hash."}</li>
          <li>{locale === "zh" ? "得到 eligible / limited / rejected 之一，附原因码。休市时 STRICT_LIVE 的正确答案就是拒绝。" : "Get eligible / limited / rejected with reason codes. Outside regular hours the correct STRICT_LIVE answer is a rejection."}</li>
          <li>{t("cert_ttl_line")}</li>
        </ol>
      </Card>
    </div>
  );
}
