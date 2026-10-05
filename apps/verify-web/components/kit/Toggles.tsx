"use client";
/**
 * 筛选控件（列表 / 事件台工具条共用）：
 *  - FilterChip：可多个并列的筛选 chip（aria-pressed），选中 = 品牌描边 + 品牌底；可带计数
 *  - Segmented：互斥的分段选择（时间范围、模式），role="group" + aria-pressed
 * 状态写 URL 由调用方负责（useQueryState）。
 */
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function FilterChip({ selected, onClick, count, children }: { selected: boolean; onClick: () => void; count?: number; children: ReactNode }) {
  return (
    <Button type="button" variant="outline" size="sm" aria-pressed={selected} onClick={onClick}
      className={cn("h-8 gap-1.5 rounded-full px-3 font-normal", selected ? "border-brand-400 bg-surface-brand text-fg-1 hover:bg-surface-brand" : "text-fg-2")}>
      {children}
      {count !== undefined ? <span className="text-xs text-fg-3 tabular-nums">{count}</span> : null}
    </Button>
  );
}

export function Segmented<T extends string | number>({ value, options, onChange, label, className }: {
  value: T;
  options: Array<{ value: T; label: ReactNode }>;
  onChange: (v: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={cn("inline-flex rounded-md border bg-surface-1 p-0.5", className)}>
      {options.map((o) => (
        <Button key={String(o.value)} type="button" size="sm" variant={value === o.value ? "secondary" : "ghost"} aria-pressed={value === o.value} className="h-7 px-3 tabular-nums" onClick={() => onChange(o.value)}>
          {o.label}
        </Button>
      ))}
    </div>
  );
}
