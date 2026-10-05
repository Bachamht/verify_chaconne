"use client";
import Link from "next/link";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Amount } from "@/components/kit/Amount";
import { DataTable, type ColumnDef } from "@/components/kit/DataTable";
import { NotReturned } from "@/components/kit/NotReturned";
import { KeyValue } from "@/components/kit/KeyValue";
import { ToneTag } from "@/components/kit/StatusBadge";
import { useI18n } from "@/lib/i18n";
import { reclaimable, type AssetRow } from "./fundsModel";

export interface AssetTableProps {
  rows: AssetRow[];
  /** 额度接口没拿到（PlanGuard 列显示「未返回」而不是空） */
  allowancesMissing: boolean;
  readingChain: boolean;
  onReclaim: (row: AssetRow) => void;
}

const unknownPrecision = (zh: boolean) => (zh ? "精度未知，不换算金额" : "Unknown precision; amount not converted");

function Missing({ reading }: { reading?: boolean }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  if (reading) return <span className="text-fg-3">{zh ? "读取中" : "Reading"}</span>;
  return <NotReturned title={zh ? "链上读取失败，不当作 0" : "On-chain read failed; not treated as 0"} />;
}

function amountOf(raw: string | null, row: AssetRow, missing: ReactNode, zh: boolean) {
  if (raw !== null && row.decimals === null) return <NotReturned title={unknownPrecision(zh)} />;
  return raw === null ? missing : <Amount raw={raw} decimals={row.decimals} maxFrac={row.kind === "cash" ? 2 : 6} />;
}

function useCells({ allowancesMissing, readingChain, onReclaim }: Omit<AssetTableProps, "rows">) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  return {
    zh,
    asset: (r: AssetRow) => (
      <span className="flex min-w-0 items-baseline gap-2">
        {r.symbol ? <span className="truncate font-medium text-fg-1" translate="no">{r.symbol}</span> : <span className="truncate font-medium text-fg-3">{zh ? "未登记资产" : "Unregistered asset"}</span>}
        <span className="shrink-0 text-xs text-fg-3">{r.kind === "cash" ? (zh ? "资金币种" : "Funding") : (zh ? "股票" : "Stock")}</span>
      </span>
    ),
    balance: (r: AssetRow) => (
      <span title={r.balanceSource === "rpc" ? (zh ? "服务端没读到，浏览器直读链上" : "Read directly from the chain by your browser") : undefined}>
        {amountOf(r.balanceRaw, r, <Missing reading={readingChain} />, zh)}
      </span>
    ),
    planGuard: (r: AssetRow) => r.planGuard
      ? r.decimals === null ? <NotReturned title={unknownPrecision(zh)} /> : <Amount raw={r.planGuard.onchainRaw} decimals={r.decimals} maxFrac={r.kind === "cash" ? 2 : 6} />
      : allowancesMissing ? <Missing /> : <span className="text-fg-3">—</span>,
    action: (r: AssetRow) => r.planGuard?.pendingPermit
      ? <ToneTag tone="info">{zh ? "额度上链中" : "Going on-chain"}</ToneTag>
      : reclaimable(r)
        ? <Button variant="outline" size="sm" onClick={() => onReclaim(r)}>{zh ? "收回" : "Reclaim"}</Button>
        : null,
  };
}

export function AssetTable(props: AssetTableProps) {
  const c = useCells(props);
  const zh = c.zh;
  const columns: ColumnDef<AssetRow, unknown>[] = [
    { id: "asset", header: zh ? "资产" : "Asset", cell: ({ row }) => c.asset(row.original), meta: { className: "w-[26%]" } },
    { id: "balance", header: zh ? "余额" : "Balance", cell: ({ row }) => c.balance(row.original), meta: { align: "right" } },
    { id: "planGuard", header: zh ? "已授权额度" : "Allowance", cell: ({ row }) => c.planGuard(row.original), meta: { align: "right" } },
    { id: "action", header: () => <span className="sr-only">{zh ? "动作" : "Action"}</span>, cell: ({ row }) => c.action(row.original), meta: { align: "right", className: "w-32" } },
  ];
  return (
    <DataTable
      columns={columns}
      data={props.rows}
      getRowId={(r) => r.assetKey}
      caption={zh ? "资产余额与链上额度" : "Balances and on-chain allowances"}
      cardRow={(r) => (
        <div className="flex flex-col gap-2 rounded-md border bg-surface-1 p-3">
          <div className="flex min-h-8 items-center justify-between gap-2">{c.asset(r)}{c.action(r)}</div>
          <KeyValue dense items={[
            { label: zh ? "余额" : "Balance", value: c.balance(r) },
            { label: zh ? "已授权额度" : "Allowance", value: c.planGuard(r) },
          ]} />
        </div>
      )}
    />
  );
}

export function AllowanceFootnote() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  return (
    <p className="text-xs text-fg-3">
      {zh
        ? "残余额度只能配合你签过的有效授权使用，过期的授权会被合约拒绝。收回额度只改变链上额度；暂停任务、取消任务和撤销授权是各自独立的操作，"
        : "Leftover allowance can only be used with valid authorizations you have signed. Expired authorizations are rejected by the contract. Reclaiming changes only the on-chain allowance, while pausing a task, cancelling it, and revoking an authorization are separate actions available "}
      <Link href="/agent/tasks" className="text-brand-300 underline-offset-4 hover:underline">{zh ? "在各任务页里操作" : "on each task page"}</Link>
      {zh ? "。任务结束不会自动收回额度。" : ". Ending a task does not automatically reclaim its allowance."}
    </p>
  );
}
