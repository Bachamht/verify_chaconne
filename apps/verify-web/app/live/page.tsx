"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { pubList, type PublicReport } from "@/lib/api-v2";
import { useI18n } from "@/lib/i18n";
import { ReportCard } from "@/components/ReportCard";
import { Card, EmptyState } from "@/components/ui";

export default function LivePage() {
  const { t, locale } = useI18n();
  const [items, setItems] = useState<PublicReport[] | null>(null);
  useEffect(() => {
    pubList().then((r) => setItems(r.status === 200 ? [...r.data.items].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) : []));
  }, []);
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">{t("live_h")}</h1>
      <p className="text-sm text-neutral-300">{t("live_p")}</p>
      {items === null ? (
        <p className="text-fg-2">{t("loading")}</p>
      ) : items.length === 0 ? (
        <EmptyState compact title={t("live_empty_h")} description={t("live_empty_p")} primary={{ href: "/new", label: t("nav_new") }} secondary={{ href: "/play", label: t("nav_play") }} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {items.map((r) => (
            <Card key={r.shareId}>
              <ReportCard r={r} compact />
              <div className="mt-3 flex gap-2">
                <Link href={`/r/${r.shareId}`} className="btn-ghost px-3 py-1 text-sm">{locale === "zh" ? "查看" : "Open"}</Link>
                {r.templateId && <Link href={`/${r.kind === "job" ? "new" : "plan"}?template=${r.templateId}`} className="btn px-3 py-1 text-sm">{t("share_remix")}</Link>}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
