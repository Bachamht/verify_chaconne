"use client";
/**
 * 活动流（compact 密度，content-visibility）：每条 = 时间 · 谁 · 一句人话（lib/activityText）；
 * Agent 原话折叠在句子下面（中英混排长段落可展开）；状态回声默认收起，可切「显示全部」。
 */
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/kit/FourStates";
import { Hash } from "@/components/kit/Hash";
import { Panel } from "@/components/kit/Panel";
import { StatusBadge } from "@/components/kit/StatusBadge";
import { Timestamp } from "@/components/kit/Timestamp";
import { AgentQuote } from "@/components/kit/AgentQuote";
import { TONE_DOT } from "@/components/kit/tone";
import { actorLabel, humanizeActivity } from "@/lib/activityText";
import type { AssetEntry } from "@/lib/assets";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { ActivityFeedState } from "@/components/agent/tasks/v7/useActivityFeed";

const PAGE = 40;

export function ActivityPanel({ feed, sim, assets, stableKey }: { feed: Pick<ActivityFeedState, "items" | "status" | "http" | "refresh">; sim: boolean; assets: AssetEntry[]; stableKey: string | null }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const [all, setAll] = useState(false);
  const [limit, setLimit] = useState(PAGE);
  const rows = useMemo(() => [...feed.items].reverse().map((it) => ({ it, t: humanizeActivity(it, { locale, assets, stableAssetKey: stableKey }) })), [feed.items, locale, assets, stableKey]);
  const shown = rows.filter((r) => all || !r.t.minor);
  return (
    <Panel id="activity" aria-label={zh ? "活动记录" : "Activity"}>
      <Panel.Header
        title={zh ? "活动记录" : "Activity"}
        description={zh ? "发生了什么，按时间倒序。" : "What happened, newest first."}
        action={<div className="flex items-center gap-2">{sim ? <StatusBadge status="simulation" /> : null}<Switch id="act-all" checked={all} onCheckedChange={setAll} /><Label htmlFor="act-all" className="text-xs text-fg-2">{zh ? "含状态变化" : "Include status changes"}</Label></div>}
      />
      <Panel.Body>
        {feed.status === "busy" && rows.length === 0 ? <LoadingBlock rows={5} onRetry={feed.refresh} />
          : (feed.status === "nr" || feed.status === "offline") && rows.length === 0 ? <ErrorState size="sm" status={feed.http} onRetry={feed.refresh} />
          : shown.length === 0 ? <EmptyState size="sm" title={zh ? "还没有活动" : "No activity yet"} description={zh ? "Agent 开始一轮后，这里会显示它查了什么、怎么想、做了什么。" : "Once the agent starts a round, this shows what it checked, how it reasoned and what it did."} />
          : (
          <ol className="flex flex-col">
            {shown.slice(0, limit).map(({ it, t }) => (
              <li key={String(it.id)} className="v8-cv flex gap-3 border-b py-2.5 last:border-b-0">
                <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", TONE_DOT[t.tone])} aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className={cn("text-sm break-words", t.minor ? "text-fg-2" : "text-fg-1")}>{t.text}</p>
                  {t.quote ? <AgentQuote text={t.quote} className="mt-1.5" /> : null}
                  <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-fg-3">
                    <Timestamp at={it.at} mode="both" />
                    <span>· {actorLabel(it.actor, locale)}</span>
                    {t.nextCheckAt ? <span>· {zh ? "下次检查 " : "next check "}<Timestamp at={t.nextCheckAt} mode="abs" /></span> : null}
                    {t.txHash ? <Hash value={t.txHash} kind="tx" /> : null}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        )}
        {shown.length > limit ? <Button variant="outline" size="sm" className="mt-3" onClick={() => setLimit((l) => l + PAGE)}>{zh ? "加载更早的记录" : "Load earlier entries"}</Button> : null}
      </Panel.Body>
    </Panel>
  );
}
