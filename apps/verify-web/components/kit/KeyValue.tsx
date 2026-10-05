import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** 键值列表（「边界」卡、概要抽屉）：左标签 fg-2，右值 fg-1 右对齐 tabular；空值 "—" */
export function KeyValue({ items, className, dense = false }: {
  items: Array<{ label: ReactNode; value: ReactNode | null | undefined; hint?: ReactNode; key?: string }>;
  className?: string;
  dense?: boolean;
}) {
  return (
    <dl className={cn("divide-y divide-line", className)}>
      {items.map((it, i) => (
        <div key={it.key ?? i} className={cn("flex min-w-0 items-baseline justify-between gap-4", dense ? "py-2" : "py-2.5")}>
          <dt className="shrink-0 text-sm text-fg-2">
            {it.label}
            {it.hint ? <span className="block text-xs text-fg-3">{it.hint}</span> : null}
          </dt>
          <dd className="min-w-0 text-right text-sm break-words text-fg-1 tabular-nums">
            {it.value === null || it.value === undefined || it.value === "" ? <span className="text-fg-3">—</span> : it.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
