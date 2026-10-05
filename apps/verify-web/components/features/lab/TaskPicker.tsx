"use client";
import type { Task } from "@chaconne/core/verify";
import { useI18n } from "@/lib/i18n";
import type { AssetEntry } from "@/lib/assets";
import type { ResourceState } from "@/lib/useResource";
import { STATUS_META, taskUiStatus } from "@/lib/status";
import { taskTitle } from "@/components/agent/tasks/taskTitle";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { StatusBadge } from "@/components/kit/StatusBadge";
import { Hash } from "@/components/kit/Hash";

/** 三个 tab 共用的任务选择（写 URL ?task=）。列表取不到时给重试，不让人手填 id */
export function TaskPicker({ tasks, state, assets, value, onChange, onRetry }: {
  tasks: Task[];
  state: ResourceState;
  assets: AssetEntry[];
  value: string;
  onChange: (id: string) => void;
  onRetry: () => void;
}) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const current = tasks.find((t) => t.id === value) ?? null;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor="lab-task" className="text-xs text-fg-2">{zh ? "任务（诊断与对照用它；回放用它的股票）" : "Task (used by Diagnose and Compare; Replay uses its stock)"}</Label>
      {state === "loading" ? (
        <Skeleton className="h-9 w-full max-w-xl" />
      ) : state === "error" ? (
        <p className="flex flex-wrap items-center gap-2 text-sm text-fg-2">
          {zh ? "任务列表没有取到。" : "Could not load your tasks."}
          <Button variant="outline" size="sm" onClick={onRetry}>{zh ? "重试" : "Retry"}</Button>
        </p>
      ) : (
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          <Select value={current ? value : undefined} onValueChange={onChange}>
            <SelectTrigger id="lab-task" className="w-full max-w-xl min-w-0">
              <SelectValue placeholder={tasks.length ? (zh ? "选一个任务" : "Pick a task") : (zh ? "还没有任务" : "No tasks yet")} />
            </SelectTrigger>
            <SelectContent position="popper" className="max-h-80">
              {tasks.map((t) => (
                <SelectItem key={t.id} value={t.id}>
                  <span className="truncate">{taskTitle(t, null, assets, locale)}</span>
                  <span className="shrink-0 text-xs text-fg-3">{STATUS_META[taskUiStatus(t.status)][locale]}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {current ? <><StatusBadge status={taskUiStatus(current.status)} /><Hash value={current.id} kind="id" /></> : null}
          {value && !current && tasks.length > 0 ? <span className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-fg-2"><Hash value={value} kind="id" />{zh ? "不在当前任务列表里（可能已归档），仍按链接里的任务诊断与对照。" : "Not in your current task list (maybe archived); Diagnose and Compare still use the linked task."}</span> : null}
        </div>
      )}
    </div>
  );
}
