"use client";
/** 右侧详情抽屉（URL ?event= / ?tab=）：详情 tab（事件 · 新鲜度 · Agent 会怎么做）+ 财报覆盖 tab；底部一个主动作 +「更多」。 */
import { useState } from "react";
import { DetailSheet } from "@/components/kit/DetailSheet";
import { EmptyState } from "@/components/kit/FourStates";
import { ToneTag } from "@/components/kit/StatusBadge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useI18n } from "@/lib/i18n";
import { ActionOutcome } from "./ActionOutcome";
import { copy, EVENT_STATUS } from "./copy";
import { CoverageTab } from "./CoverageTab";
import { EventActions, type ActionRun } from "./EventActions";
import { EventDetail } from "./EventDetail";
import { eventName, kindMeta } from "./eventText";
import type { EventDesk } from "./useEventDesk";

export function EventSheet({ desk, owner, eventId, onClose, tab, onTab }: {
  desk: EventDesk;
  owner: string;
  eventId: string;
  onClose: () => void;
  tab: string;
  onTab: (t: string) => void;
}) {
  const { locale } = useI18n();
  const c = copy(locale);
  // 范围外的事件（链接分享 / 刚切了范围）也能打开：从整份日历的命中里找
  const shown = desk.allRows.find((r) => r.ev.id === eventId) ?? null;
  const ev = shown?.ev ?? null;
  const [run, setRun] = useState<{ id: string; run: ActionRun } | null>(null);
  const meta = ev ? kindMeta(ev.kind) : null;
  const loading = desk.calendar.state === "loading";

  return (
    <DetailSheet
      open={Boolean(eventId)}
      onOpenChange={(o) => { if (!o) onClose(); }}
      width="lg"
      title={ev ? eventName(ev, locale) : loading ? "…" : c("not_returned")}
      badges={ev && meta ? <><ToneTag tone={meta.tone}>{meta[locale]}</ToneTag>{EVENT_STATUS[ev.status] ? <ToneTag tone="muted">{EVENT_STATUS[ev.status]![locale]}</ToneTag> : null}</> : undefined}
      footer={shown ? <EventActions owner={owner} eventId={shown.ev.id} ev={shown.ev} hits={shown.hits} onResult={(r) => setRun(r ? { id: shown.ev.id, run: r } : null)} /> : undefined}
    >
      <Tabs value={tab === "coverage" ? "coverage" : "detail"} onValueChange={(v) => onTab(v === "detail" ? "" : v)}>
        <TabsList variant="line" className="mb-4">
          <TabsTrigger value="detail">{c("tab_detail")}</TabsTrigger>
          <TabsTrigger value="coverage">{c("tab_coverage")}</TabsTrigger>
        </TabsList>
        <TabsContent value="detail" className="flex flex-col gap-6">
          {run && shown && run.id === shown.ev.id ? <ActionOutcome run={run.run} owner={owner} eventId={shown.ev.id} /> : null}
          {shown ? <EventDetail row={shown} desk={desk} /> : loading ? null : (
            <EmptyState size="sm" title={locale === "zh" ? "没有找到这个事件" : "Event not found"} description={locale === "zh" ? "它可能已经不在日历里，或者链接不完整。" : "It may no longer be on the calendar, or the link is incomplete."} />
          )}
        </TabsContent>
        <TabsContent value="coverage">
          <CoverageTab assets={desk.assetList} />
        </TabsContent>
      </Tabs>
    </DetailSheet>
  );
}
