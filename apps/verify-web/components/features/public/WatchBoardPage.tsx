"use client";
/**
 * /live/agent/:shareId（v8 值守看板，决赛现场观众用手机看）：5 s 轮询（页面隐藏即停，useResource）。
 * 只显示类别与时间：数据先经 normalizePublicActivity 白名单（at + category + actor），再经固定标签表（boardLabels）；
 * 不显示任何金额、数量、地址或自由文本。?v7fixture=1 用示例数据（标「示例数据」）。
 */
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/kit/FourStates";
import { PageHeader } from "@/components/kit/PageHeader";
import { Panel } from "@/components/kit/Panel";
import { KpiRow, StatTile } from "@/components/kit/StatTile";
import { ModeTag, StatusBadge } from "@/components/kit/StatusBadge";
import { Timestamp } from "@/components/kit/Timestamp";
import { useI18n } from "@/lib/i18n";
import { tv } from "@/lib/i18n.v7";
import { pubTaskActivity } from "@/lib/publicData";
import { useResource } from "@/lib/useResource";
import { v7FixtureRequested } from "@/lib/v7";
import { fxPublicActivity } from "@/lib/v7fixtures";
import { presenceUiStatus, watchView } from "./publicView";

export function WatchBoardPage({ shareId }: { shareId: string }) {
  return <Suspense fallback={null}><WatchBoardBody shareId={shareId} /></Suspense>;
}

function WatchBoardBody({ shareId }: { shareId: string }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  // 服务端与浏览器读同一个查询参数，首帧一致（不水合报错）
  const fixture = v7FixtureRequested(useSearchParams()?.toString() ?? "");
  const res = useResource(`pub:watch:${shareId}:${fixture ? "fx" : "live"}`, async () => (fixture ? { status: 200, data: fxPublicActivity() } : pubTaskActivity(shareId)), { intervalMs: fixture ? null : 5000, ok: (s) => s === 200 });
  const view = watchView(res.data, locale);
  const presence = presenceUiStatus(res.data?.presence);
  return (
    <>
      <PageHeader
        title={tv(locale, "pb_h")}
        description={<>{tv(locale, "pb_lead")} {tv(locale, "pb_updated")}</>}
        badges={<>{presence ? <StatusBadge status={presence} /> : null}{fixture ? <ModeTag mode="FIXTURE" /> : null}{view.mode ? <ModeTag mode={view.mode} /> : null}</>}
      />
      {res.state === "loading" || res.state === "idle" ? (
        <LoadingBlock rows={6} onRetry={res.reload} />
      ) : res.state === "error" && res.status === 404 ? (
        <Panel><EmptyState title={tv(locale, "pb_not_found")} description={zh ? "看板由任务所有者打开或关闭；请向分享者确认链接。" : "The task owner opens or closes the board; check the link with whoever shared it."} /></Panel>
      ) : res.state === "error" ? (
        <Panel><ErrorState status={res.status ?? 0} description={tv(locale, "unreachable")} onRetry={res.reload} /></Panel>
      ) : (
        <div className="flex flex-col gap-6">
          <KpiRow>
            <StatTile label={tv(locale, "pb_now")} value={view.now ? <span className="block truncate text-md">{view.now}</span> : null} />
            <StatTile label={zh ? "活动条数" : "Activity entries"} value={view.total} />
            <StatTile label={zh ? "成交确认" : "Fills confirmed"} value={view.fills} hint={zh ? "只有链上确认才算成交" : "Only on-chain confirmation counts as a fill"} />
            <StatTile label={zh ? "最近活动" : "Latest activity"} value={view.lastAt ? <Timestamp at={view.lastAt} mode="rel" className="text-md" /> : null} />
          </KpiRow>
          <Panel aria-label={zh ? "活动类别" : "Activity categories"}>
            <Panel.Header title={zh ? "活动" : "Activity"} description={zh ? "最新在前，最多 60 条；只显示类别。" : "Newest first, up to 60; categories only."} />
            <Panel.Body>
              {view.items.length === 0 ? <EmptyState size="sm" title={tv(locale, "pb_empty")} description={zh ? "Agent 有动作后会自动出现在这里。" : "Entries appear here as soon as the agent acts."} /> : (
                <ol className="divide-y divide-line" aria-live="polite">
                  {view.items.map((it) => (
                    <li key={it.key} className="flex min-h-11 items-center gap-4 py-2 text-sm">
                      <Timestamp at={it.at} mode="abs" className="w-28 shrink-0 text-xs text-fg-3" />
                      <span className="min-w-0 flex-1 truncate text-fg-1">{it.label}</span>
                      {it.actor ? <span className="shrink-0 text-xs text-fg-2">{it.actor}</span> : null}
                    </li>
                  ))}
                </ol>
              )}
            </Panel.Body>
          </Panel>
        </div>
      )}
    </>
  );
}
