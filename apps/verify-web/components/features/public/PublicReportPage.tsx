"use client";
/**
 * /r/:shareId（v8）：公开战报。PageHeader（结论 + 状态 / 模式徽章）→ KpiRow（完成比例、支出、到账、费用）→ 目标与理由 → 核验结果 → 证据。
 * 私密或不存在（403/404）是「真的看不到」，用 EmptyState；其它失败用 ErrorState。永不显示钱包地址（publicReportView 清洗）。
 */
import Link from "next/link";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/kit/FourStates";
import { PageHeader } from "@/components/kit/PageHeader";
import { Panel } from "@/components/kit/Panel";
import { KpiRow, StatTile } from "@/components/kit/StatTile";
import { Timestamp } from "@/components/kit/Timestamp";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useI18n } from "@/lib/i18n";
import { pubReport } from "@/lib/publicData";
import { requestIdOf, useResource } from "@/lib/useResource";
import { publicReportView } from "./publicView";
import { ReportBadges } from "./ReportBadges";
import { ReportCheck } from "./ReportCheck";
import { PublicReportEvidence, PublicReportGoal } from "./PublicReportEvidence";

function PublicReportSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-8 w-2/3" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-lg" />)}</div>
      <Skeleton className="h-48 rounded-lg" />
    </div>
  );
}

export function PublicReportPage({ shareId }: { shareId: string }) {
  const { t, locale } = useI18n();
  const zh = locale === "zh";
  const res = useResource(`pub:report:${shareId}`, () => pubReport(shareId), { ok: (s) => s === 200 });
  if (res.state === "loading" || res.state === "idle") return <LoadingBlock shape={<PublicReportSkeleton />} onRetry={res.reload} />;
  if (res.state === "error" || !res.data) {
    if (res.status === 403 || res.status === 404 || res.status === 401) {
      return (
        <Panel>
          <EmptyState
            title={zh ? "这份战报是私密的，或不存在" : "This report is private or does not exist"}
            description={zh ? "所有者可能关闭了公开，或链接不完整。" : "The owner may have made it private, or the link is incomplete."}
            action={<Button asChild size="sm" variant="outline"><Link href="/live">{zh ? "看其它公开战报" : "See other public reports"}</Link></Button>}
          />
        </Panel>
      );
    }
    return <Panel><ErrorState status={res.status ?? 0} requestId={requestIdOf(res.errorBody)} onRetry={res.reload} title={zh ? "战报没有加载出来" : "The report did not load"} /></Panel>;
  }
  const v = publicReportView(res.data, locale);
  return (
    <>
      <PageHeader
        title={v.title}
        badges={<ReportBadges view={v} />}
        description={<>
          {v.personaName ? <>{v.personaName} · </> : null}
          {v.simulation ? (zh ? "模拟核验记录 · 不代表已执行交易" : "Simulation record · no executed trade is implied") : (zh ? "任务结果记录 · 以报告与链上回执为准" : "Task result record · refer to the report and on-chain receipts")}
          {" · "}<Timestamp at={v.createdAt} mode="abs" />
        </>}
      />
      <div className="flex flex-col gap-6">
        {/* 只是一次核验时四个数都没有：空壳整块隐藏 */}
        {v.completionPct === null && !v.spent && !v.received && !v.fees ? null : <KpiRow>
          <StatTile label={t("plan_completion")} value={v.completionPct === null ? null : `${v.completionPct}%`} />
          <StatTile label={zh ? "支出" : "Spent"} value={v.spent} />
          <StatTile label={zh ? "到账" : "Received"} value={v.received} hint={v.simulation ? (zh ? "模拟：没有真实到账" : "Simulation: nothing was received") : undefined} />
          <StatTile label={zh ? "费用" : "Fees"} value={v.fees} />
        </KpiRow>}
        <div className="grid min-w-0 gap-4 lg:grid-cols-2">
          <PublicReportGoal view={v} />
          <PublicReportEvidence view={v} />
        </div>
        {res.data.kind === "job" && v.check ? <ReportCheck check={v.check} executed={v.hashes.txHashes.length > 0} /> : null}
      </div>
    </>
  );
}
