"use client";
import type { ColumnDef } from "@tanstack/react-table";
import type { Locale } from "@/lib/i18n";
import { Amount } from "@/components/kit/Amount";
import { StatusBadge } from "@/components/kit/StatusBadge";
import { Timestamp } from "@/components/kit/Timestamp";
import { modeUiStatus } from "@/lib/status";
import type { TaskRow } from "./model";

const L = (locale: Locale, zh: string, en: string) => (locale === "zh" ? zh : en);

/** 下一步：一句话 + 相对时间（下次检查 / 自从） */
export function NextCell({ row, locale }: { row: TaskRow; locale: Locale }) {
  const { text, at, label } = row.next;
  return (
    <span className="flex min-w-0 flex-col leading-tight">
      <span className="truncate text-fg-1" title={text}>{text}</span>
      {at ? (
        <span className="truncate text-xs text-fg-3">
          {label === "next_check" ? L(locale, "下次检查 ", "Next check ") : L(locale, "自 ", "Since ")}<Timestamp at={at} mode="rel" />
        </span>
      ) : null}
    </span>
  );
}

/** 预算已用：真实任务 = 已花 / 上限；观察任务不交易 */
export function SpentCell({ row, locale }: { row: TaskRow; locale: Locale }) {
  if (row.mode === "SIMULATION") return <span className="text-fg-3">{L(locale, "不交易", "No trades")}</span>;
  return (
    <span className="inline-flex items-baseline justify-end gap-1">
      <Amount raw={row.spentRaw} decimals={row.stableDecimals} maxFrac={2} />
      <span className="text-xs text-fg-3">/</span>
      <Amount raw={row.capRaw} decimals={row.stableDecimals} symbol={row.stableSymbol} maxFrac={2} className="text-fg-2" />
    </span>
  );
}

export function ModeCell({ row }: { row: TaskRow }) {
  const s = modeUiStatus(row.mode);
  return s ? <StatusBadge status={s} /> : <span className="text-fg-3">—</span>;
}

export function taskColumns(locale: Locale): ColumnDef<TaskRow, unknown>[] {
  return [
    {
      id: "title", header: L(locale, "任务", "Task"), meta: { className: "w-[28%]" },
      cell: ({ row }) => (
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="truncate font-medium text-fg-1" title={row.original.title}>{row.original.title}</span>
          <span className="truncate text-xs text-fg-3">{row.original.stocks.join(" + ") || "—"}</span>
        </span>
      ),
    },
    { id: "status", header: L(locale, "状态", "Status"), meta: { className: "w-28" }, cell: ({ row }) => <StatusBadge status={row.original.status} /> },
    { id: "next", header: L(locale, "下一步", "Next"), cell: ({ row }) => <NextCell row={row.original} locale={locale} /> },
    { id: "spent", header: L(locale, "预算已用", "Budget used"), meta: { align: "right", className: "w-36" }, cell: ({ row }) => <SpentCell row={row.original} locale={locale} /> },
    { id: "mode", header: L(locale, "模式", "Mode"), meta: { className: "w-36 pl-6" }, cell: ({ row }) => <ModeCell row={row.original} /> },
    { id: "updated", header: L(locale, "更新", "Updated"), meta: { align: "right", className: "w-24" }, cell: ({ row }) => <Timestamp at={row.original.updatedAt} mode="rel" className="text-fg-3" /> },
  ];
}

/** 手机卡片（DataTable cardRow）：同一份数据；整卡是按钮，打开抽屉 */
export function TaskCard({ row, locale, onOpen }: { row: TaskRow; locale: Locale; onOpen: (id: string) => void }) {
  return (
    <button type="button" onClick={() => onOpen(row.id)} className="flex w-full min-w-0 flex-col gap-2 rounded-md border bg-card p-3 text-left hover:border-line-strong">
      <span className="flex min-w-0 items-start justify-between gap-2">
        <span className="min-w-0 text-sm font-medium break-words text-fg-1">{row.title}</span>
        <StatusBadge status={row.status} />
      </span>
      <span className="text-sm"><NextCell row={row} locale={locale} /></span>
      <span className="flex items-center justify-between gap-2 text-sm">
        <ModeCell row={row} />
        <SpentCell row={row} locale={locale} />
      </span>
    </button>
  );
}
