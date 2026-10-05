import { Skeleton } from "@/components/ui/skeleton";
import { Panel } from "@/components/kit/Panel";

/** 与 JournalDay 等形：4 个 KPI + 回执列表（时间 / 动作两行 / 标签） */
export function JournalSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex flex-col gap-2 rounded-lg border bg-card p-4">
            <Skeleton className="h-3 w-16" />
            <Skeleton className="h-7 w-20" />
          </div>
        ))}
      </div>
      <Panel>
        <Panel.Header title={<Skeleton className="h-4 w-24" />} />
        <Panel.Body className="flex flex-col divide-y divide-line">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="flex gap-4 py-4">
              <Skeleton className="h-3.5 w-20 shrink-0" />
              <div className="flex flex-1 flex-col gap-2">
                <Skeleton className="h-3.5 w-3/5" />
                <Skeleton className="h-3 w-2/5" />
              </div>
              <Skeleton className="h-5 w-16 shrink-0" />
            </div>
          ))}
        </Panel.Body>
      </Panel>
    </div>
  );
}
