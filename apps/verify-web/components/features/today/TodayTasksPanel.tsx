"use client";
import Link from "next/link";
import { useMemo } from "react";
import { ArrowUpRight } from "lucide-react";
import type { ColumnDef } from "@tanstack/react-table";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/kit/Panel";
import { DataTable } from "@/components/kit/DataTable";
import { StatusBadge } from "@/components/kit/StatusBadge";
import { useI18n } from "@/lib/i18n";
import { NextCell } from "../tasks/taskColumns";
import type { TaskRow } from "../tasks/model";

const MAX = 5;

/** 任务：未结束的优先、按更新时间，最多 5 条 + 查看全部。点行进控制台 */
export function TodayTasksPanel({ rows }: { rows: TaskRow[] }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const top = useMemo(() => [...rows].sort((a, b) => Number(a.group === "ended") - Number(b.group === "ended")).slice(0, MAX), [rows]);
  const columns = useMemo<ColumnDef<TaskRow, unknown>[]>(() => [
    { id: "title", header: zh ? "任务" : "Task", meta: { className: "w-[40%]" }, cell: ({ row }) => <Link href={`/agent/tasks/${row.original.id}`} className="ch-today-task-link" title={row.original.title}><span>{row.original.title}</span><ArrowUpRight className="size-3.5" aria-hidden="true" /></Link> },
    { id: "status", header: zh ? "状态" : "Status", meta: { className: "w-28" }, cell: ({ row }) => <StatusBadge status={row.original.status} /> },
    { id: "next", header: zh ? "下一步" : "Next", cell: ({ row }) => <NextCell row={row.original} locale={locale} /> },
  ], [zh, locale]);
  return (
    <Panel className="ch-today-tasks">
      <Panel.Header
        title={zh ? "任务" : "Tasks"}
        description={zh ? `共 ${rows.length} 个，先看没结束的` : `${rows.length} in total, open ones first`}
        action={<Button asChild variant="outline" size="sm"><Link href="/agent/tasks">{zh ? "查看全部" : "View all"}</Link></Button>}
      />
      <Panel.Body flush className="ch-today-tasks-body">
        <DataTable
          columns={columns}
          data={top}
          getRowId={(r) => r.id}
          rowHref={(r) => `/agent/tasks/${r.id}`}
          density="comfortable"
          className="ch-today-task-table"
          caption={zh ? "最近的任务" : "Recent tasks"}
          cardRow={(r) => (
            <Link href={`/agent/tasks/${r.id}`} className="ch-today-task-card">
              <span className="ch-today-task-card-heading"><span>{r.title}</span><StatusBadge status={r.status} /></span>
              <span className="ch-today-task-card-next"><NextCell row={r} locale={locale} /><ArrowUpRight className="size-4 shrink-0" aria-hidden="true" /></span>
            </Link>
          )}
        />
      </Panel.Body>
    </Panel>
  );
}
