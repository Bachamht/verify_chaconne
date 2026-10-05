"use client";
/** 事件列表一行：时间 + 等级徽章 + 名称 + 相关资产 chip + 命中任务数。整行是按钮，打开右侧详情（URL ?event=）。 */
import { ChevronRight, ListChecks } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { NotReturned } from "@/components/kit/NotReturned";
import { ToneTag } from "@/components/kit/StatusBadge";
import { useI18n } from "@/lib/i18n";
import { formatAbs } from "@/lib/numbers";
import { cn } from "@/lib/utils";
import { copy } from "./copy";
import { eventName, kindMeta, shownAt } from "./eventText";
import { isBlockingRule } from "./impact";
import type { EventRowData } from "./useEventDesk";

const MAX_CHIPS = 3;

function timeText(row: EventRowData, locale: "zh" | "en"): string {
  const at = shownAt(row.ev);
  if (at === null) return copy(locale)("date_only");
  return formatAbs(new Date(at), locale).slice(-5);
}

export function EventRow({ row, selected, onOpen, tasksFailed = false }: { row: EventRowData; selected: boolean; onOpen: () => void; tasksFailed?: boolean }) {
  const { locale } = useI18n();
  const c = copy(locale);
  const meta = kindMeta(row.ev.kind);
  const name = eventName(row.ev, locale);
  const pausing = row.hits?.filter((h) => h.rules.some(isBlockingRule)).length ?? 0;
  const estimated = row.ev.status === "estimated" || row.ev.datePrecision === "estimate";
  return (
    <li className="v8-cv">
      <button
        type="button"
        onClick={onOpen}
        aria-current={selected ? "true" : undefined}
        className={cn(
          "grid w-full min-w-0 grid-cols-[3.5rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-2.5 text-left hover:bg-surface-2 focus-visible:bg-surface-2 sm:min-h-11 sm:grid-cols-[3.5rem_auto_minmax(0,1fr)_auto_auto] sm:py-0",
          selected && "bg-surface-2",
        )}
      >
        <span className="text-sm text-fg-2 tabular-nums">
          {timeText(row, locale)}
          {estimated ? <span className="block text-xs text-fg-3 sm:hidden">{c("estimated")}</span> : null}
        </span>
        <ToneTag tone={meta.tone} className="justify-self-start">{meta[locale]}</ToneTag>
        <span className="col-span-2 col-start-2 row-start-2 min-w-0 truncate text-sm font-medium text-fg-1 sm:col-span-1 sm:col-start-auto sm:row-start-auto" title={name}>
          {name}
          {estimated ? <span className="ml-2 hidden text-xs font-normal text-fg-3 sm:inline">{c("estimated")}</span> : null}
        </span>
        <span className="col-span-2 col-start-2 row-start-3 flex min-w-0 flex-wrap gap-1 sm:col-span-1 sm:col-start-auto sm:row-start-auto sm:justify-end" translate="no">
          {row.assets.slice(0, MAX_CHIPS).map((a) => (
            <span key={a.assetKey} className="inline-flex h-5.5 items-center rounded-sm border border-line-strong bg-surface-2 px-1.5 text-xs text-fg-2">{a.displaySymbol}</span>
          ))}
          {row.assets.length > MAX_CHIPS ? <span className="text-xs text-fg-3">+{row.assets.length - MAX_CHIPS}</span> : null}
        </span>
        <span className="col-start-3 row-start-1 flex items-center justify-end gap-1 sm:col-start-auto sm:row-start-auto">
          <HitCount row={row} pausing={pausing} tasksFailed={tasksFailed} />
          <ChevronRight className="size-4 text-fg-3" aria-hidden="true" />
        </span>
      </button>
    </li>
  );
}

function HitCount({ row, pausing, tasksFailed }: { row: EventRowData; pausing: number; tasksFailed: boolean }) {
  const { locale } = useI18n();
  const c = copy(locale);
  if (row.hits === null && tasksFailed) return <NotReturned label={c("tasks_unknown")} className="text-xs" />;
  if (row.hits === null) return <Skeleton className="h-3.5 w-12" aria-label={c("impact_checking")} />;
  const n = row.hits.length;
  if (n === 0) return <span className="text-xs text-fg-3">{c("no_task")}</span>;
  const label = locale === "zh" ? `${n} ${c("tasks_n")}` : `${n} ${n === 1 ? c("task_1") : c("tasks_n")}`;
  return (
    <span className={cn("inline-flex items-center gap-1 text-xs tabular-nums", pausing ? "text-warn" : "text-fg-2")} title={pausing ? (locale === "zh" ? `${pausing} 个任务会暂停` : `${pausing} will pause`) : undefined}>
      <ListChecks className="size-3.5" aria-hidden="true" />
      {label}
    </span>
  );
}
