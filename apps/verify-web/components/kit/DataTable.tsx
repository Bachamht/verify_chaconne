"use client";
import { useRouter } from "next/navigation";
import type { KeyboardEvent, MouseEvent, ReactNode } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { flexRender, getCoreRowModel, getSortedRowModel, useReactTable, type ColumnDef, type OnChangeFn, type Row, type SortingState } from "@tanstack/react-table";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";

export interface ColumnMetaV8 {
  /** 数字列右对齐 + tabular */
  align?: "left" | "right";
  /** 列宽 / 截断等 */
  className?: string;
  /** 手机卡片里隐藏 */
  hideOnCard?: boolean;
}

/**
 * 数据表（components.md「DataTable」）：sticky 表头、固定行高 36/44、数字列右对齐、整行可点、
 * >50 行 content-visibility、排序状态由调用方写进 URL（sorting / onSortingChange）。
 * 手机（<640）改渲染 cardRow 卡片列表（同一数据）。
 */
export function DataTable<T>({ columns, data, rowHref, onRowClick, getRowId, density, cardRow, empty, sorting, onSortingChange, caption, className }: {
  columns: ColumnDef<T, unknown>[];
  data: T[];
  rowHref?: (row: T) => string | null;
  onRowClick?: (row: T) => void;
  getRowId?: (row: T, index: number) => string;
  /** 默认：>20 行自动 compact（FourStates「dense」） */
  density?: "comfortable" | "compact";
  cardRow?: (row: T) => ReactNode;
  empty?: ReactNode;
  sorting?: SortingState;
  onSortingChange?: OnChangeFn<SortingState>;
  /** 读屏用表格说明 */
  caption?: string;
  className?: string;
}) {
  const router = useRouter();
  const table = useReactTable({
    data,
    columns,
    getRowId,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    state: sorting ? { sorting } : undefined,
    onSortingChange,
    manualSorting: false,
  });
  const dense = (density ?? (data.length > 20 ? "compact" : "comfortable")) === "compact";
  const many = data.length > 50;
  const clickable = Boolean(rowHref || onRowClick);

  function onKey(row: Row<T>, e: KeyboardEvent) {
    if (e.key !== "Enter" && e.key !== " ") return;
    if ((e.target as HTMLElement) !== e.currentTarget) return;
    e.preventDefault();
    if (onRowClick) return onRowClick(row.original);
    const href = rowHref?.(row.original);
    if (href) router.push(href);
  }

  function activate(row: Row<T>, e: MouseEvent) {
    // 行内的按钮 / 链接自己处理
    if ((e.target as HTMLElement).closest("a,button,input,label,[role=menuitem]")) return;
    if (onRowClick) return onRowClick(row.original);
    const href = rowHref?.(row.original);
    if (href) router.push(href);
  }

  if (data.length === 0 && empty) return <>{empty}</>;

  return (
    <div className={cn("min-w-0", className)}>
      <div className={cn(cardRow ? "hidden sm:block" : "block")}>
        <Table className="table-fixed">
          {caption ? <caption className="sr-only">{caption}</caption> : null}
          <TableHeader className="sticky top-0 z-10 bg-card">
            {table.getHeaderGroups().map((hg) => (
              <TableRow key={hg.id} className="hover:bg-transparent">
                {hg.headers.map((h) => {
                  const meta = h.column.columnDef.meta as ColumnMetaV8 | undefined;
                  const sortable = h.column.getCanSort() && Boolean(onSortingChange);
                  const dir = h.column.getIsSorted();
                  return (
                    <TableHead key={h.id} className={cn("h-9 text-xs font-medium text-fg-2", meta?.align === "right" && "text-right", meta?.className)} aria-sort={dir === "asc" ? "ascending" : dir === "desc" ? "descending" : undefined}>
                      {h.isPlaceholder ? null : sortable ? (
                        <button type="button" className={cn("inline-flex items-center gap-1 hover:text-fg-1", meta?.align === "right" && "flex-row-reverse")} onClick={h.column.getToggleSortingHandler()}>
                          {flexRender(h.column.columnDef.header, h.getContext())}
                          {dir === "asc" ? <ArrowUp className="size-3" aria-hidden="true" /> : dir === "desc" ? <ArrowDown className="size-3" aria-hidden="true" /> : null}
                        </button>
                      ) : flexRender(h.column.columnDef.header, h.getContext())}
                    </TableHead>
                  );
                })}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {table.getRowModel().rows.map((row) => (
              <TableRow key={row.id} onClick={clickable ? (e) => activate(row, e) : undefined} onKeyDown={clickable ? (e) => onKey(row, e) : undefined} tabIndex={clickable ? 0 : undefined} className={cn(dense ? "h-9" : "h-11", clickable && "cursor-pointer focus-visible:bg-surface-2", many && "v8-cv")}>
                {row.getVisibleCells().map((cell) => {
                  const meta = cell.column.columnDef.meta as ColumnMetaV8 | undefined;
                  return (
                    <TableCell key={cell.id} className={cn("truncate py-0 text-sm", meta?.align === "right" && "text-right tabular-nums", meta?.className)}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {cardRow ? (
        <ul className="flex flex-col gap-2 sm:hidden">
          {table.getRowModel().rows.map((row) => (
            <li key={row.id} className={cn(many && "v8-cv")}>{cardRow(row.original)}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export type { ColumnDef, SortingState };
