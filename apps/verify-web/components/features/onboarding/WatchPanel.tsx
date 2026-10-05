"use client";
/**
 * 第 2 步「先跑给我看」：观察任务（SIMULATION）的 Agent 状态 + 最近活动（人话，不露原始码与最小单位）。
 * 轮询与游标在 useActivityFeed（与任务控制台共用）。完整记录在任务控制台。
 */
import Link from "next/link";
import { AgentSays } from "@/components/kit/AgentSays";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/kit/FourStates";
import { Panel } from "@/components/kit/Panel";
import { StatusBadge } from "@/components/kit/StatusBadge";
import { Timestamp } from "@/components/kit/Timestamp";
import { humanizeActivity } from "@/lib/activityText";
import type { AssetEntry } from "@/lib/assets";
import { useI18n } from "@/lib/i18n";
import { tv, type V7Key } from "@/lib/i18n.v7";
import { useActivityFeed } from "@/components/agent/tasks/v7/useActivityFeed";
import { presenceKey } from "@/components/agent/tasks/v7/runtimeModel";

const SHOW = 8;

export function WatchPanel({ taskId, fixture, assets, stableKey, consoleHref }: { taskId: string; fixture: boolean; assets: AssetEntry[]; stableKey: string | null; consoleHref: string }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const feed = useActivityFeed(taskId, { fixture, mode: "SIMULATION" });
  const key = presenceKey(feed.runtime?.presence ?? null);
  const rows = feed.items.map((it) => ({ it, h: humanizeActivity(it, { locale, assets, stableAssetKey: stableKey }) })).filter((r) => !r.h.minor).slice(-SHOW).reverse();
  return (
    <Panel>
      <Panel.Header
        title={zh ? "观察 Agent 的下一步" : "Watch the agent's next move"}
        action={<StatusBadge status="simulation" />}
      />
      <Panel.Body className="flex flex-col gap-3">
        <p className="flex items-center gap-2 text-sm text-fg-1" aria-live="polite">
          <span className="text-fg-2">{zh ? "Agent 状态" : "Agent status"}</span>
          {feed.runtime ? tv(locale, key as V7Key) : <span className="text-fg-3">{zh ? "正在获取" : "Fetching"}</span>}
        </p>
        {feed.status === "busy" && feed.items.length === 0 ? <LoadingBlock rows={3} onRetry={feed.refresh} />
          : (feed.status === "nr" || feed.status === "offline") && feed.items.length === 0 ? <ErrorState size="sm" status={feed.http} title={zh ? "暂时拿不到活动记录" : "Activity is unavailable right now"} onRetry={feed.refresh} />
          : rows.length === 0 ? <EmptyState size="sm" title={zh ? "Agent 还没有动作" : "No activity yet"} description={zh ? "第一轮通常在几分钟内开始。它也可能判断现在不该动，那同样是一次完整的决定。" : "The first round usually starts within minutes. It may also decide not to act, which is a complete decision too."} />
          : (
            <ol className="flex flex-col divide-y divide-line">
              {rows.map(({ it, h }, i) => (
                <li key={String(it.id)} className="flex min-w-0 flex-col gap-1.5 py-2.5">
                  <div className="flex min-w-0 items-baseline justify-between gap-3">
                    <span className="min-w-0 text-sm text-fg-1">{h.text}</span>
                    <Timestamp at={it.at} mode="rel" className="shrink-0 text-xs text-fg-3" />
                  </div>
                  {h.quote ? (i === 0 ? <AgentSays>{h.quote}</AgentSays> : <p className="border-l-2 border-line-strong pl-3 text-sm text-fg-2">{h.quote}</p>) : null}
                </li>
              ))}
            </ol>
          )}
        <Link href={consoleHref} className="self-start text-sm text-brand-400 underline-offset-4 hover:text-brand-300 hover:underline">{zh ? "在任务台查看完整观察记录" : "Open the full observation record"}</Link>
      </Panel.Body>
    </Panel>
  );
}
