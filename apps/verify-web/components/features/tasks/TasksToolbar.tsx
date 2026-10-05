"use client";
import { useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { FilterChip } from "@/components/kit/Toggles";
import { useI18n } from "@/lib/i18n";
import { GROUP_LABEL, STATUS_GROUPS, type StatusGroup, type TaskFilter } from "./model";

const MODES: Array<{ id: TaskFilter["mode"]; zh: string; en: string }> = [
  { id: "all", zh: "全部模式", en: "All modes" },
  { id: "simulation", zh: "观察", en: "Observe" },
  { id: "live", zh: "真实", en: "Live" },
];


/** 工具条：状态 chip（带计数）· 模式 · 搜索。全部写进 URL（由调用方的 useQueryState 负责） */
export function TasksToolbar({ filter, counts, onGroup, onMode, onQuery }: {
  filter: TaskFilter;
  counts: Record<StatusGroup | "all", number>;
  onGroup: (g: StatusGroup | "all") => void;
  onMode: (m: TaskFilter["mode"]) => void;
  onQuery: (q: string) => void;
}) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const [q, setQ] = useState(filter.q);
  const sent = useRef(filter.q);
  // URL 被别处改了（后退 / 清除筛选）才回填输入框；输入停 250ms 再写 URL，避免每个键都 replace
  useEffect(() => {
    if (filter.q !== sent.current) { sent.current = filter.q; setQ(filter.q); }
  }, [filter.q]);
  useEffect(() => {
    if (q === sent.current) return;
    const id = setTimeout(() => { sent.current = q; onQuery(q); }, 250);
    return () => clearTimeout(id);
  }, [q, onQuery]);
  return (
    <div className="mb-4 flex min-w-0 flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex min-w-0 flex-wrap items-center gap-2" role="group" aria-label={zh ? "按状态筛选" : "Filter by status"}>
        <FilterChip selected={filter.group === "all"} onClick={() => onGroup("all")}>{zh ? "全部" : "All"}<span className="text-xs text-fg-3 tabular-nums">{counts.all}</span></FilterChip>
        {STATUS_GROUPS.map((g) => (
          <FilterChip key={g} selected={filter.group === g} onClick={() => onGroup(filter.group === g ? "all" : g)}>
            {GROUP_LABEL[g][locale]}<span className="text-xs text-fg-3 tabular-nums">{counts[g]}</span>
          </FilterChip>
        ))}
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <div className="flex items-center gap-1" role="group" aria-label={zh ? "按模式筛选" : "Filter by mode"}>
          {MODES.map((m) => <FilterChip key={m.id} selected={filter.mode === m.id} onClick={() => onMode(m.id)}>{m[locale]}</FilterChip>)}
        </div>
        <label className="relative block w-full min-w-0 sm:w-56">
          <span className="sr-only">{zh ? "搜索任务" : "Search tasks"}</span>
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-fg-3" aria-hidden="true" />
          <Input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={zh ? "标题、股票或任务编号" : "Title, stock or task ID"} className="h-8 pl-8" />
        </label>
      </div>
    </div>
  );
}
