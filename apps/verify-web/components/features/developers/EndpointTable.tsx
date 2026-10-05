"use client";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { useI18n } from "@/lib/i18n";
import type { EndpointRow } from "./restEndpoints";

/**
 * 端点表（shadcn Table，不引 tanstack，开发者页要轻）：路径列等宽可换行、说明列必填。
 * 手机（<640）每行变成上下两段，不出现横向滚动（B4）。
 */
export function EndpointTable({ rows, caption }: { rows: readonly EndpointRow[]; caption: string }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  return (
    <Table className="table-fixed">
      <caption className="sr-only">{caption}</caption>
      <TableHeader className="max-sm:hidden">
        <TableRow className="hover:bg-transparent">
          <TableHead className="h-9 w-2/5 text-xs text-fg-2">{zh ? "端点" : "Endpoint"}</TableHead>
          <TableHead className="h-9 text-xs text-fg-2">{zh ? "说明" : "What it does"}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map(([path, dZh, dEn]) => (
          <TableRow key={path} className="align-top hover:bg-transparent max-sm:flex max-sm:flex-col max-sm:py-2">
            <TableCell className="py-2.5 font-mono text-xs leading-5 wrap-anywhere whitespace-normal text-fg-1 max-sm:py-0.5" translate="no">{path}</TableCell>
            <TableCell className="py-2.5 text-sm leading-5 whitespace-normal text-fg-2 max-sm:py-0.5">{(zh ? dZh : dEn) || "—"}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
