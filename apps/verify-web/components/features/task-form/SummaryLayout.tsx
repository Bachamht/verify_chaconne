"use client";
import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useI18n } from "@/lib/i18n";

/**
 * 左表单 + 右摘要（≥1050 两栏，摘要吸顶）；单栏时摘要折叠到顶部 Collapsible（components.md §3「两栏规则」）。
 * peek：折叠态触发器上的一句概要（如「10 USDG · 2 只股票 · 只买入」）。
 */
export function SummaryLayout({ main, summary, peek }: { main: ReactNode; summary: ReactNode; peek: ReactNode }) {
  const { locale } = useI18n();
  return (
    <div className="grid min-w-0 gap-6 min-[1050px]:grid-cols-[minmax(0,1fr)_340px] min-[1050px]:items-start">
      <Collapsible className="min-w-0 min-[1050px]:hidden">
        <CollapsibleTrigger asChild>
          <Button type="button" variant="outline" className="group h-auto w-full justify-between gap-3 px-4 py-3 text-left">
            <span className="flex min-w-0 flex-col">
              <span className="text-sm font-medium text-fg-1">{locale === "zh" ? "范围摘要" : "Scope summary"}</span>
              <span className="truncate text-xs font-normal text-fg-2">{peek}</span>
            </span>
            <ChevronDown className="text-fg-3 transition-transform group-data-[state=open]:rotate-180" aria-hidden="true" />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-3">{summary}</CollapsibleContent>
      </Collapsible>
      <div className="flex min-w-0 flex-col gap-4">{main}</div>
      <aside className="hidden min-w-0 min-[1050px]:sticky min-[1050px]:top-24 min-[1050px]:block">{summary}</aside>
    </div>
  );
}
