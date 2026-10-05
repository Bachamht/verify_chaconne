"use client";
import { ModeTag, StatusBadge, ToneTag } from "@/components/kit/StatusBadge";
import { useI18n } from "@/lib/i18n";
import type { PublicReportView } from "./publicView";

/** 战报的两个徽章：结果状态 + 数据模式（一行最多两个） */
export function ReportBadges({ view }: { view: Pick<PublicReportView, "badge" | "mode"> }) {
  const { locale } = useI18n();
  const b = view.badge;
  return (
    <span className="inline-flex flex-wrap items-center gap-2">
      {"status" in b ? <StatusBadge status={b.status} /> : <ToneTag tone={b.tone}>{b.label[locale]}</ToneTag>}
      <ModeTag mode={view.mode} />
    </span>
  );
}

/** 「买入 AAPLx + NVDAx 用 USDG · 100 USDG」：资产名已经过地址清洗 */
export function GoalLine({ goal }: { goal: PublicReportView["goal"] }) {
  const { t, locale } = useI18n();
  const zh = locale === "zh";
  return (
    <span className="min-w-0 break-words">
      {goal.side === "buy" ? t("plan_side_buy") : t("plan_side_sell")} {goal.assets.join(" + ") || "—"} {zh ? "用" : "with"} {goal.input || "—"}
      {goal.amount ? <span className="tabular-nums"> · {goal.amount}</span> : null}
    </span>
  );
}
