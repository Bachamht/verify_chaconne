"use client";
/** 财报覆盖 tab：每只股票 = 覆盖状态 + 下一份财报日期 + 最近探测。数据来自 GET /v1/events/earnings/coverage（快），点开 tab 才取。 */
import type { ColumnDef } from "@tanstack/react-table";
import { DataTable } from "@/components/kit/DataTable";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/kit/FourStates";
import { ToneTag } from "@/components/kit/StatusBadge";
import { Timestamp } from "@/components/kit/Timestamp";
import type { AssetEntry } from "@/lib/assets";
import { useI18n } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";
import { requestIdOf, useResource } from "@/lib/useResource";
import { eventsApi } from "./api";
import { copy, COVERAGE } from "./copy";
import { coverageRows, type CoverageView } from "./coverage";

function cols(locale: Locale): ColumnDef<CoverageView, unknown>[] {
  const c = copy(locale);
  return [
    { accessorKey: "symbol", header: c("asset"), cell: ({ row }) => <span className="font-medium text-fg-1" translate="no">{row.original.symbol}</span> },
    { accessorKey: "state", header: c("cov_state"), cell: ({ row }) => { const m = COVERAGE[row.original.state] ?? COVERAGE.not_probed!; return <ToneTag tone={m.tone}>{m[locale]}</ToneTag>; } },
    { accessorKey: "nextReport", header: c("cov_next"), cell: ({ row }) => row.original.nextReport ? <span className="tabular-nums">{row.original.nextReport.slice(5).replace("-", "/")}</span> : <span className="text-fg-3">—</span>, meta: { align: "right" } },
    { accessorKey: "lastProbedAt", header: c("cov_probed"), cell: ({ row }) => <Timestamp at={row.original.lastProbedAt} mode="rel" className="text-fg-3" />, meta: { align: "right", hideOnCard: true } },
  ];
}

export function CoverageTab({ assets }: { assets: AssetEntry[] }) {
  const { locale } = useI18n();
  const c = copy(locale);
  const r = useResource("earnings-coverage", () => eventsApi.coverage());
  const today = new Date().toISOString().slice(0, 10);
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-fg-2">{c("cov_desc")}</p>
      {r.state === "loading" ? <LoadingBlock rows={5} onRetry={r.reload} /> : r.state === "error" ? (
        <ErrorState size="sm" status={r.status ?? 0} requestId={requestIdOf(r.errorBody)} onRetry={r.reload} />
      ) : (
        <DataTable
          columns={cols(locale)}
          data={coverageRows(r.data?.coverage ?? [], assets, today)}
          density="compact"
          caption={c("tab_coverage")}
          empty={<EmptyState size="sm" title={c("cov_empty")} />}
        />
      )}
      <p className="text-xs text-fg-3">{c("cov_corp")}</p>
    </div>
  );
}
