"use client";
/** 按天分组的事件列表 + 等形骨架（日期标题 + 44px 行）。 */
import { Skeleton } from "@/components/ui/skeleton";
import { useI18n } from "@/lib/i18n";
import { dayLabel, groupByDay } from "./eventText";
import { EventRow } from "./EventRow";
import type { EventRowData } from "./useEventDesk";

export function EventList({ rows, nowMs, selectedId, onOpen, tasksFailed = false }: { rows: EventRowData[]; nowMs: number; selectedId: string; onOpen: (id: string) => void; tasksFailed?: boolean }) {
  const { locale } = useI18n();
  const groups = groupByDay(rows, (r) => r.ev);
  return (
    <div className="flex flex-col">
      {groups.map((g) => (
        <section key={g.key} aria-label={dayLabel(g.key, locale, nowMs)} className="group/day border-t first:border-t-0">
          <h2 className="sticky top-14 z-10 flex items-center justify-between bg-card px-4 py-2 group-first/day:rounded-t-lg text-xs font-medium text-fg-2">
            <span>{dayLabel(g.key, locale, nowMs)}</span>
            <span className="text-fg-3 tabular-nums">{g.rows.length}</span>
          </h2>
          <ul className="flex flex-col divide-y divide-line">
            {g.rows.map((r) => <EventRow key={r.ev.id} row={r} selected={selectedId === r.ev.id} onOpen={() => onOpen(r.ev.id)} tasksFailed={tasksFailed} />)}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** 与最终列表等形：两个日期组，每组若干 44px 行（时间 · 徽章 · 名称 · chip · 计数） */
export function EventListSkeleton({ groups = 2, rows = 3 }: { groups?: number; rows?: number }) {
  return (
    <div className="flex flex-col">
      {Array.from({ length: groups }, (_, g) => (
        <div key={g} className="group/day border-t first:border-t-0">
          <div className="px-4 py-2"><Skeleton className="h-3 w-28" /></div>
          <div className="flex flex-col divide-y divide-line">
            {Array.from({ length: rows }, (_, i) => (
              <div key={i} className="flex h-11 items-center gap-3 px-4">
                <Skeleton className="h-3.5 w-10" />
                <Skeleton className="h-5 w-16" />
                <Skeleton className="h-3.5 w-2/5" />
                <Skeleton className="ml-auto h-3.5 w-14" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
