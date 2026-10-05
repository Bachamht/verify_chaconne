"use client";
/**
 * /live（v8）：所有者自愿公开的战报，最新在前。KpiRow（只有计数，不按收益排名）+ 战报卡片。
 * 数据只走 lib/publicData（无 key、无钱包代码）；每张卡的文字都经 publicReportView 清洗（永不显示钱包地址）。
 */
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/kit/FourStates";
import { PageHeader } from "@/components/kit/PageHeader";
import { Panel } from "@/components/kit/Panel";
import { KpiRow, StatTile } from "@/components/kit/StatTile";
import { Timestamp } from "@/components/kit/Timestamp";
import { Skeleton } from "@/components/ui/skeleton";
import { useI18n } from "@/lib/i18n";
import { pubList, type PublicReport } from "@/lib/publicData";
import { requestIdOf, useResource } from "@/lib/useResource";
import { boardKpis, publicReportView } from "./publicView";
import { GoalLine, ReportBadges } from "./ReportBadges";

function sortNewest(items: PublicReport[]): PublicReport[] {
  return [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function ReportSummaryCard({ r }: { r: PublicReport }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const v = publicReportView(r, locale);
  return (
    <Panel as="article" className="h-full">
      <Panel.Header title={v.title} description={<GoalLine goal={v.goal} />} eyebrow={<Timestamp at={v.createdAt} mode="rel" />} />
      <Panel.Body className="mt-auto flex flex-wrap items-center justify-between gap-3">
        <ReportBadges view={v} />
        <span className="flex items-center gap-2">
          <Button asChild variant="outline" size="sm"><Link href={`/r/${v.shareId}`}>{zh ? "查看战报" : "Open report"}</Link></Button>
        </span>
      </Panel.Body>
    </Panel>
  );
}

function LiveSkeleton() {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-lg" />)}</div>
      <div className="grid gap-4 md:grid-cols-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-36 rounded-lg" />)}</div>
    </div>
  );
}

export function LiveBoard() {
  const { t, locale } = useI18n();
  const zh = locale === "zh";
  const res = useResource("pub:reports", async () => {
    const r = await pubList();
    return { status: r.status, data: sortNewest(r.data.items) };
  }, { isEmpty: (d) => d.length === 0 });
  const items = res.data ?? [];
  const k = boardKpis(items);
  return (
    <>
      <PageHeader title={t("live_h")} description={t("live_p")} />
      {res.state === "loading" || res.state === "idle" ? (
        <LoadingBlock shape={<LiveSkeleton />} onRetry={res.reload} />
      ) : res.state === "error" ? (
        <Panel><ErrorState status={res.status ?? 0} requestId={requestIdOf(res.errorBody)} onRetry={res.reload} title={zh ? "公开战报没有加载出来" : "Public reports did not load"} /></Panel>
      ) : res.state === "empty" ? (
        <Panel>
          <EmptyState title={t("live_empty_h")} description={t("live_empty_p")} />
        </Panel>
      ) : (
        <div className="flex flex-col gap-6">
          <KpiRow>
            <StatTile label={zh ? "公开战报" : "Public reports"} value={k.total} />
            <StatTile label={zh ? "已完成" : "Completed"} value={k.completed} />
            <StatTile label={zh ? "等待或部分完成" : "Waiting or partial"} value={k.waiting} />
            <StatTile label={zh ? "观察（模拟）" : "Simulation"} value={k.simulation} hint={zh ? "模拟不执行交易" : "Simulations never trade"} />
          </KpiRow>
          <ul className="grid gap-4 md:grid-cols-2">
            {items.map((r) => <li key={r.shareId} className="min-w-0"><ReportSummaryCard r={r} /></li>)}
          </ul>
        </div>
      )}
    </>
  );
}
