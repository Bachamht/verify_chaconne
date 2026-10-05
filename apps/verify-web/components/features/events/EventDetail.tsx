"use client";
/** 详情 tab：事件本体 → 新鲜度三件套（更新于 / 心跳 / 偏差）→ Agent 会怎么做 → 服务端当前判断（后台补上）。 */
import { LoaderCircle } from "lucide-react";
import type { MarketEvent } from "@chaconne/core/verify";
import { Blockers } from "@/components/kit/Blockers";
import { KeyValue } from "@/components/kit/KeyValue";
import { ToneTag } from "@/components/kit/StatusBadge";
import { NotReturned } from "@/components/kit/NotReturned";
import { Timestamp } from "@/components/kit/Timestamp";
import { useI18n } from "@/lib/i18n";
import { copy, EVENT_STATUS, sourceName } from "./copy";
import { deviationText, eventSpan, heartbeatOf, kindMeta, shownAt } from "./eventText";
import { HitList } from "./HitList";
import { serverBlockers } from "./impact";
import type { EventDesk, EventRowData } from "./useEventDesk";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-xs font-medium text-fg-3">{title}</h3>
      {children}
    </section>
  );
}

function When({ ev }: { ev: MarketEvent }) {
  const { locale } = useI18n();
  const at = shownAt(ev);
  const exact = eventSpan(ev).exact;
  if (at !== null) return <span>{exact ? null : <span className="mr-1 text-fg-3">{locale === "zh" ? "估计" : "Est."}</span>}<Timestamp at={at} mode="both" /></span>;
  return <span className="tabular-nums">{ev.dateLocal.slice(5).replace("-", "/")} {locale === "zh" ? "全天（纽约时间）" : "all day (New York time)"}</span>;
}

export function EventDetail({ row, desk }: { row: EventRowData; desk: EventDesk }) {
  const { locale } = useI18n();
  const c = copy(locale);
  const ev = row.ev;
  const meta = kindMeta(ev.kind);
  const heartbeat = heartbeatOf(ev.source, desk.allEvents);
  const macro = ev.kind !== "EARNINGS" && ev.kind !== "CORPORATE_ACTION";
  const serverItem = desk.impacts.data?.items?.find((i) => i.event.id === ev.id) ?? null;
  const blockers = serverItem ? serverBlockers(serverItem.rules ?? [], desk.openIds) : [];
  const notReturned = <NotReturned />;

  return (
    <div className="flex flex-col gap-6">
      <KeyValue dense items={[
        { key: "when", label: c("when"), value: <When ev={ev} /> },
        { key: "kind", label: c("kind"), value: <ToneTag tone={meta.tone}>{meta[locale]}</ToneTag> },
        { key: "status", label: c("status"), value: EVENT_STATUS[ev.status]?.[locale] ?? notReturned },
        { key: "source", label: c("source"), value: sourceName(ev.source, locale) },
        { key: "assets", label: c("assets"), value: row.assets.length ? <span translate="no">{row.assets.map((a) => a.displaySymbol).join(locale === "zh" ? "、" : ", ")}</span> : null },
      ]} />
      {macro ? <p className="text-sm text-fg-2">{c("macro_note")}</p> : null}

      <Section title={c("freshness")}>
        <KeyValue dense items={[
          { key: "updated", label: c("updated"), value: ev.sourceFetchedAt ? <Timestamp at={ev.sourceFetchedAt} mode="both" /> : notReturned },
          { key: "heartbeat", label: c("heartbeat"), value: heartbeat ? <Timestamp at={heartbeat} mode="rel" /> : notReturned },
          { key: "deviation", label: c("deviation"), value: deviationText(ev, locale) },
        ]} />
      </Section>

      <Section title={c("hits_h")}>
        <HitList hits={row.hits} nowMs={desk.nowMs} tasksStatus={desk.tasks} onRetry={desk.tasks.reload} closedCount={desk.closedCount} />
      </Section>

      {row.hits && row.hits.length > 0 ? (
        <Section title={c("blockers_h")}>
          {desk.impacts.state === "loading" ? (
            <p className="flex items-center gap-2 text-sm text-fg-3" aria-live="polite"><LoaderCircle className="size-4 animate-spin" aria-hidden="true" />{c("impact_checking")}</p>
          ) : desk.impacts.state === "error" ? (
            <p className="text-sm text-fg-3">{c("impact_failed")}</p>
          ) : !serverItem ? (
            <p className="text-sm text-fg-3">{locale === "zh" ? "服务端清单没有包含这个事件；上面按你的任务条件推算。" : "The server list does not include this event; the above is worked out from your task conditions."}</p>
          ) : (
            <Blockers items={blockers} empty={<p className="text-sm text-fg-2">{locale === "zh" ? "现在没有被这个事件拦住的任务。" : "No task is held by this event right now."}</p>} />
          )}
        </Section>
      ) : null}
    </div>
  );
}
