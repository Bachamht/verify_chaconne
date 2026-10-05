"use client";
/** 路由级骨架：页头 + 工具条占位 + 等形事件列表。Suspense 兜底，首帧即出，不等钱包与接口。 */
import { Skeleton } from "@/components/ui/skeleton";
import { LoadingBlock } from "@/components/kit/FourStates";
import { PageHeader } from "@/components/kit/PageHeader";
import { Panel } from "@/components/kit/Panel";
import { useI18n } from "@/lib/i18n";
import { copy } from "./copy";
import { EventListSkeleton } from "./EventList";

export function EventsDeskFallback() {
  const { locale } = useI18n();
  const c = copy(locale);
  return (
    <div className="flex w-full min-w-0 flex-col">
      <PageHeader title={c("title")} description={c("subtitle")} />
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-5" aria-hidden="true">
          <Skeleton className="h-9 w-56" />
          <Skeleton className="h-5 w-24" />
          <Skeleton className="h-8 w-40" />
        </div>
        <Skeleton className="h-4 w-64" />
        <Panel><LoadingBlock shape={<EventListSkeleton />} /></Panel>
      </div>
    </div>
  );
}
