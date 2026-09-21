"use client";
import { useEffect, useState } from "react";
import { pubReport, type PublicReport } from "@/lib/api-v2";
import { useI18n } from "@/lib/i18n";
import { ReportCard } from "@/components/ReportCard";

export function PublicReportClient({ shareId }: { shareId: string }) {
  const { t, locale } = useI18n();
  const [r, setR] = useState<PublicReport | null>(null);
  const [status, setStatus] = useState<number | null>(null);
  useEffect(() => {
    pubReport(shareId).then((x) => {
      setStatus(x.status);
      if (x.status === 200) setR(x.data);
    });
  }, [shareId]);
  if (status && status !== 200) return <p className="text-fg-2">{locale === "zh" ? "这份战报是私密的，或不存在。" : "This report is private or does not exist."}</p>;
  if (!r) return <p className="text-fg-2">{t("loading")}</p>;
  return <ReportCard r={r} />;
}
