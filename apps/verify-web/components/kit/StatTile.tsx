import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * KPI 单格：安静的标签、轻字重等宽数字和独立的说明行。没有值传 null → "—"，不显示 0。
 * value 可以是 <Amount/> 等节点；delta 只表涨跌（up/down 色），不表状态。
 */
export function StatTile({ label, value, hint, delta, tone, className }: {
  label: ReactNode;
  value: ReactNode | null | undefined;
  hint?: ReactNode;
  /** 百分比变化，如 -0.31 */
  delta?: number | null;
  /** 需要你处理时用 warn，其他保持中性 */
  tone?: "default" | "warn" | "bad";
  className?: string;
}) {
  const empty = value === null || value === undefined || value === "";
  return (
    <div className={cn("ch-stat-tile flex min-w-0 flex-col gap-2 rounded-lg border bg-card p-5 sm:p-6", tone === "warn" && "border-warn/35", tone === "bad" && "border-bad/35", className)}>
      <span className="truncate text-xs font-medium leading-5 text-fg-2">{label}</span>
      <span className={cn("truncate text-[2rem] leading-tight font-normal tracking-[-0.035em] tabular-nums sm:text-[2.25rem]", empty ? "text-fg-3" : tone === "warn" ? "text-warn" : tone === "bad" ? "text-bad" : "text-fg-1")}>
        {empty ? "—" : value}
      </span>
      {(hint || typeof delta === "number") && (
        <span className="mt-1 flex min-w-0 items-center gap-2 text-xs leading-5 text-fg-3">
          {typeof delta === "number" ? <span className={cn("tabular-nums", delta >= 0 ? "text-up" : "text-down")}>{delta >= 0 ? "+" : ""}{delta.toFixed(2)}%</span> : null}
          {hint ? <span className="truncate">{hint}</span> : null}
        </span>
      )}
    </div>
  );
}

/** 一行最多 4 个；手机两列 */
export function KpiRow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("grid grid-cols-2 gap-3 lg:grid-cols-4", className)}>{children}</div>;
}
