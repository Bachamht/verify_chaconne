"use client";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/kit/Panel";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/kit/FourStates";
import { Countdown, Timestamp } from "@/components/kit/Timestamp";
import { ToneTag } from "@/components/kit/StatusBadge";
import { useNow } from "@/components/kit/useNow";
import { copy, type CopyKey } from "@/components/agent/events/copy";
import type { ImpactsResponse } from "@/components/agent/events/api";
import { useI18n } from "@/lib/i18n";
import { requestIdOf, type Resource } from "@/lib/useResource";
import { upcomingEvents } from "./model";
import { eventName } from "@/components/features/events/eventText";

/** 下一个事件：未来 7 天里最近的 3 个（含倒计时）；与你的任务 / 持仓有关的标出来 */
export function EventsPanel({ res }: { res: Resource<ImpactsResponse> }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const c = copy(locale);
  const now = useNow(60_000);
  const list = res.data && now ? upcomingEvents(res.data.items ?? [], now) : [];
  const kind = (k: string) => { const key = `kind_${k}` as CopyKey; try { return c(key) ?? k; } catch { return zh ? "事件" : "Event"; } };
  return (
    <Panel>
      <Panel.Header title={zh ? "下一个事件" : "Next events"} action={<Button asChild variant="link" size="sm" className="h-auto p-0"><Link href="/agent/events">{zh ? "事件台" : "Event desk"}</Link></Button>} />
      <Panel.Body>
        {res.state === "loading" || res.state === "idle" || (res.data && !now) ? <LoadingBlock rows={3} onRetry={res.reload} /> : null}
        {res.state === "error" ? <ErrorState size="sm" status={res.status ?? undefined} requestId={requestIdOf(res.errorBody)} onRetry={res.reload} title={zh ? "事件没有拿到" : "Events did not load"} /> : null}
        {res.data && now && list.length === 0 ? <EmptyState size="sm" title={zh ? "未来 7 天没有已知事件" : "No known events in the next 7 days"} description={zh ? "这是如实的空，不是故障。" : "An honest empty list, not a failure."} /> : null}
        {list.length > 0 ? (
          <ul className="flex flex-col divide-y divide-line">
            {list.map(({ event: e, relevance, rules }) => {
              const at = e.scheduledAtUtc ?? `${e.dateLocal}T23:59:59Z`;
              const estimated = e.datePrecision !== "exact" || e.status === "estimated";
              return (
                <li key={e.id} className="flex min-w-0 flex-col gap-1 py-3">
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    <p className="min-w-0 truncate text-sm font-medium text-fg-1" title={eventName(e, locale)}>{eventName(e, locale)}</p>
                    <Countdown to={at} className="shrink-0 text-sm text-fg-1" doneLabel={zh ? "进行中" : "Now"} />
                  </div>
                  <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-3">
                    <ToneTag tone="neutral">{kind(e.kind)}</ToneTag>
                    {relevance !== "universe" ? <ToneTag tone="warn">{zh ? `涉及你的${rules.length > 0 ? ` ${rules.length} 个任务` : "持仓"}` : rules.length > 0 ? `${rules.length} of your tasks` : "Your holdings"}</ToneTag> : null}
                    <Timestamp at={at} mode="abs" />
                    {estimated ? <span>{zh ? "估计时间" : "estimated"}</span> : null}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : null}
      </Panel.Body>
    </Panel>
  );
}
