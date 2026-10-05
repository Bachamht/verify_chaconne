"use client";
import { ChevronRight } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { CompareView } from "@/components/agent/lab/api";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Hash } from "@/components/kit/Hash";
import { Timestamp } from "@/components/kit/Timestamp";
import { snapshotSummary } from "./labText";

/** 证据快照折叠成一行摘要；展开看快照 id 与每个事件版本（id · 修订号 · 首次可知时间） */
export function SnapshotLine({ s }: { s: CompareView["snapshot"] | null | undefined }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  if (!s) return <p className="text-sm text-fg-3">{zh ? "证据快照未返回" : "Evidence snapshot not returned"}</p>;
  return (
    <Collapsible className="min-w-0 rounded-md border bg-surface-2">
      <CollapsibleTrigger className="group flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-sm text-fg-2 hover:text-fg-1 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
        <ChevronRight className="size-4 shrink-0 transition-transform duration-200 group-data-[state=open]:rotate-90" aria-hidden="true" />
        <span className="shrink-0 font-medium text-fg-1">{zh ? "证据快照" : "Evidence snapshot"}</span>
        <span className="min-w-0 truncate">{snapshotSummary(s, locale)}</span>
        <span className="ml-auto hidden shrink-0 text-xs text-fg-3 sm:inline"><Timestamp at={s.takenAt} mode="abs" /></span>
      </CollapsibleTrigger>
      <CollapsibleContent className="border-t px-3 py-2">
        <p className="flex flex-wrap items-center gap-2 text-xs text-fg-3">{zh ? "快照" : "Snapshot"} <Hash value={s.id} kind="id" /> · <Timestamp at={s.takenAt} mode="both" /></p>
        {(s.eventVersions ?? []).length === 0 ? (
          <p className="mt-1 text-xs text-fg-3">{zh ? "这次快照没有事件版本。" : "No event versions in this snapshot."}</p>
        ) : (
          <ul className="mt-1 flex flex-col gap-1">
            {s.eventVersions.map((e) => (
              <li key={`${e.id}#${e.revision}`} className="flex flex-wrap items-center gap-2 text-xs text-fg-2">
                <Hash value={e.id} kind="id" />
                <span className="tabular-nums">{zh ? `第 ${e.revision} 版` : `rev ${e.revision}`}</span>
                <span className="text-fg-3">{zh ? "首次可知 " : "first known "}<Timestamp at={e.firstKnownAt} mode="abs" /></span>
              </li>
            ))}
          </ul>
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}
