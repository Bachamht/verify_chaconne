"use client";
/**
 * 资金组区块：列表（portfolio.budgetGroups）→ 详情抽屉（?group=<id>，任务页会直接链过来）+「新建资金组」。
 * 资金组是服务端协调（D-086），不是链上冻结；与链上额度分开显示，不混算。
 */
import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Amount } from "@/components/kit/Amount";
import { NotReturned } from "@/components/kit/NotReturned";
import { DataTable, type ColumnDef } from "@/components/kit/DataTable";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/kit/FourStates";
import { Panel } from "@/components/kit/Panel";
import { ToneTag } from "@/components/kit/StatusBadge";
import { Timestamp } from "@/components/kit/Timestamp";
import { useI18n } from "@/lib/i18n";
import { useQueryState } from "@/lib/useQueryState";
import { requestIdOf, type Resource } from "@/lib/useResource";
import type { PortfolioView } from "@/lib/api-v2";
import { BudgetGroupSheet } from "./BudgetGroupSheet";
import { CreateBudgetGroupDialog } from "./CreateBudgetGroupDialog";
import { periodEnded, type AssetMeta, type PortfolioBudgetGroup } from "./fundsModel";

export function BudgetGroups({ owner, groups, pf, assets }: { owner: string; groups: PortfolioBudgetGroup[] | null; pf: Resource<PortfolioView>; assets: AssetMeta[] }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const [group, setGroup] = useQueryState("group");
  const [creating, setCreating] = useState(false);
  const meta = (k: string) => assets.find((a) => a.assetKey === k);
  // 缺值或精度未知 → 「未返回」，不补 0、不猜精度
  const amt = (raw: string | null, g: PortfolioBudgetGroup) => {
    const dec = meta(g.inputAssetKey)?.tokenDecimals;
    return raw === null || dec === undefined ? <NotReturned /> : <Amount raw={raw} decimals={dec} maxFrac={2} />;
  };
  const columns: ColumnDef<PortfolioBudgetGroup, unknown>[] = [
    { id: "name", header: zh ? "名称" : "Name", cell: ({ row }) => <span className="font-medium text-fg-1" title={row.original.name}>{row.original.name}</span>, meta: { className: "w-[30%]" } },
    { id: "cur", header: zh ? "币种" : "Currency", cell: ({ row }) => <span className="text-fg-2" translate="no">{meta(row.original.inputAssetKey)?.displaySymbol ?? "—"}</span> },
    { id: "cap", header: zh ? "上限" : "Cap", cell: ({ row }) => amt(row.original.capRaw, row.original), meta: { align: "right" } },
    { id: "spent", header: zh ? "已花" : "Spent", cell: ({ row }) => amt(row.original.spentRaw, row.original), meta: { align: "right", hideOnCard: true } },
    { id: "reserved", header: zh ? "预留" : "Reserved", cell: ({ row }) => amt(row.original.reservedRaw, row.original), meta: { align: "right" } },
    { id: "end", header: zh ? "周期结束" : "Period ends", cell: ({ row }) => periodEnded(row.original) ? <ToneTag tone="muted">{zh ? "本期已结束" : "Period over"}</ToneTag> : <Timestamp at={row.original.periodEnd} mode="rel" className="text-fg-2" />, meta: { align: "right" } },
  ];

  let body;
  if (pf.state === "loading" || pf.state === "idle") body = <div className="px-5 pb-5"><LoadingBlock rows={2} onRetry={pf.reload} /></div>;
  else if (pf.state === "error") body = <ErrorState size="sm" status={pf.status ?? 0} requestId={requestIdOf(pf.errorBody)} onRetry={pf.reload} title={zh ? "资金组没有拿到" : "Budget groups did not load"} />;
  else if (!groups || groups.length === 0) {
    body = (
      <EmptyState size="sm" title={groups ? (zh ? "还没有资金组" : "No budget group yet") : (zh ? "这次没有返回资金组" : "Budget groups were not returned")}
        description={zh ? "资金组给多个任务共用一笔预算和现金下限；任务超出时会排队等额度。" : "A budget group shares one budget and cash floor across tasks; tasks over the cap wait for room."}
        action={<Button variant="outline" size="sm" onClick={() => setCreating(true)}><Plus aria-hidden="true" />{zh ? "新建资金组" : "New budget group"}</Button>} />
    );
  } else {
    body = (
      <DataTable columns={columns} data={groups} getRowId={(g) => g.id} onRowClick={(g) => setGroup(g.id)} caption={zh ? "资金组" : "Budget groups"}
        cardRow={(g) => (
          <button type="button" onClick={() => setGroup(g.id)} className="flex w-full flex-col gap-1 rounded-md border bg-surface-1 p-3 text-left hover:border-line-strong">
            <span className="flex items-center justify-between gap-2"><span className="truncate text-sm font-medium text-fg-1">{g.name}</span>{periodEnded(g) ? <ToneTag tone="muted">{zh ? "本期已结束" : "Period over"}</ToneTag> : null}</span>
            <span className="flex justify-between text-xs text-fg-3"><span>{zh ? "上限" : "Cap"} {amt(g.capRaw, g)}</span><span>{zh ? "预留" : "Reserved"} {amt(g.reservedRaw, g)}</span></span>
          </button>
        )} />
    );
  }

  return (
    <Panel>
      <Panel.Header
        title={zh ? "资金组" : "Budget groups"}
        description={zh ? "服务端为任务排队用的预算，不是链上冻结；每一步执行前仍会重查真实余额。" : "Service-side budgets for queuing tasks, not on-chain freezes; the real balance is re-checked before every step."}
        action={groups && groups.length > 0 ? <Button variant="outline" size="sm" onClick={() => setCreating(true)}><Plus aria-hidden="true" />{zh ? "新建资金组" : "New budget group"}</Button> : null}
      />
      <Panel.Body flush className="px-4 pb-4 sm:px-0 sm:pb-2">{body}</Panel.Body>
      <BudgetGroupSheet id={group || null} assets={assets} onOpenChange={(o) => { if (!o) setGroup(null); }} />
      <CreateBudgetGroupDialog open={creating} onOpenChange={setCreating} owner={owner} assets={assets} onCreated={(id) => { setCreating(false); pf.reload(); setGroup(id); }} />
    </Panel>
  );
}
