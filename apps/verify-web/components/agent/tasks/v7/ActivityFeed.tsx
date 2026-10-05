"use client";
/** 活动流（P3）：时间 · 谁 · 一句话；SIMULATION 任务整块标 SIMULATION（观察模式不签证书、不执行）。 */
import { formatTime } from "@/lib/format";
import { Card } from "@/components/ui";
import { NotReady } from "../../shared";
import { activityCategory, activityHasText } from "./runtimeModel";
import type { ActivityFeedState } from "./useActivityFeed";
import { useV7 } from "./useV7";

export function ActivityFeed({ feed, sim, title }: { feed: Pick<ActivityFeedState, "items" | "status" | "http" | "intervalMs" | "hidden" | "refresh">; sim: boolean; title?: string }) {
  const { s, m, locale } = useV7();
  const items = [...feed.items].reverse();
  const polling = feed.hidden ? s("act_polling_paused") : feed.intervalMs === 3000 ? s("act_polling_fast") : feed.intervalMs ? s("act_polling_slow") : null;
  return (
    <Card title={title ?? s("act_h")} right={polling ? <span className="ag-note">{polling}</span> : undefined}>
      {sim && <p className="mb-3"><span className="v7-sim" data-testid="sim-badge">{s("act_sim_badge")}</span></p>}
      {feed.status === "nr" ? <NotReady what="GET /v1/tasks/:id/activity" status={feed.http} onRetry={feed.refresh} /> : feed.status === "offline" && items.length === 0 ? <p className="ag-note">{s("unreachable")}</p> : items.length === 0 ? <p className="ag-note">{feed.status === "busy" ? s("loading") : s("act_empty")}</p> : (
        <ol className="v7-feed" aria-live="polite">
          {items.map((it) => {
            const cat = activityCategory(it);
            const who = m(`actor_${it.actor}`) ?? String(it.actor).split(":")[0];
            return (
              <li key={String(it.id)} data-cat={cat}>
                <span>{activityHasText(it) ? it.note : (m(`cat_${cat}`) ?? s("cat_other"))}</span>
                <span className="v7-feed-meta"><time dateTime={it.at}>{formatTime(it.at, locale)}</time><span>{who}</span><span>{m(`cat_${cat}`) ?? s("cat_other")}</span></span>
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}
