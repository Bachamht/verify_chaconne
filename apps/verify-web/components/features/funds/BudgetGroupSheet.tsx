"use client";
import Link from "next/link";
import { budgetGroups } from "@/lib/api-v2";
import { Amount } from "@/components/kit/Amount";
import { NotReturned } from "@/components/kit/NotReturned";
import { DetailSheet } from "@/components/kit/DetailSheet";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/kit/FourStates";
import { Hash } from "@/components/kit/Hash";
import { KeyValue } from "@/components/kit/KeyValue";
import { ToneTag } from "@/components/kit/StatusBadge";
import { Timestamp } from "@/components/kit/Timestamp";
import { useI18n } from "@/lib/i18n";
import { requestIdOf, useResource } from "@/lib/useResource";
import { allocationStateLabel, allocationsOf, normalizeBudgetGroup, periodEnded, type AssetMeta } from "./fundsModel";

const STATE_TONE: Record<string, "ok" | "warn" | "muted" | "neutral"> = { reserved: "ok", waiting: "warn", released: "muted", settled: "neutral" };

/** 资金组详情（URL ?group=<id>，刷新可恢复；任务页「查看资金组」直接落到这里） */
export function BudgetGroupSheet({ id, assets, onOpenChange }: { id: string | null; assets: AssetMeta[]; onOpenChange: (open: boolean) => void }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const r = useResource(id ? `bg:${id}` : null, () => budgetGroups.get(id!));
  const g = r.data ? normalizeBudgetGroup(r.data) : null;
  const allocations = r.data ? allocationsOf(r.data) : [];
  const a = g ? assets.find((x) => x.assetKey === g.inputAssetKey) : undefined;
  const dec = a?.tokenDecimals ?? null;
  const sym = a?.displaySymbol ?? null;
  // 缺值或精度未知 → 「未返回」，不补 0、不猜精度
  const amt = (raw: string | null) => (raw === null || dec === null ? <NotReturned /> : <Amount raw={raw} decimals={dec} symbol={sym} maxFrac={2} />);

  let body;
  if (r.state === "loading" || r.state === "idle") body = <LoadingBlock rows={6} onRetry={r.reload} />;
  else if (r.state === "error" || !g) {
    body = <ErrorState size="sm" status={r.status ?? 0} requestId={requestIdOf(r.errorBody)} onRetry={r.reload}
      title={r.status === 404 ? (zh ? "找不到这个资金组" : "Budget group not found") : undefined}
      description={r.status === 404 ? (zh ? "它可能属于另一个钱包，或链接里的编号不对。" : "It may belong to another wallet, or the link has a wrong ID.") : undefined} />;
  } else {
    body = (
      <div className="flex flex-col gap-5">
        <KeyValue items={[
          { label: zh ? "资金币种" : "Currency", value: sym },
          { label: zh ? "本期上限" : "Cap this period", hint: zh ? "服务额度，不是链上额度" : "Service budget, not an on-chain allowance", value: amt(g.capRaw) },
          { label: zh ? "现金下限" : "Cash floor", value: amt(g.cashFloorRaw) },
          { label: zh ? "已花" : "Spent", value: amt(g.spentRaw) },
          { label: zh ? "预留" : "Reserved", value: amt(g.reservedRaw) },
          { label: zh ? "在途" : "In flight", value: amt(g.pendingRaw) },
          { label: zh ? "周期" : "Period", value: <span className="inline-flex flex-wrap justify-end gap-x-1"><Timestamp at={g.periodStart} mode="abs" /><span className="text-fg-3">→</span><Timestamp at={g.periodEnd} mode="abs" /></span> },
          { label: zh ? "编号" : "ID", value: <Hash value={g.id} kind="id" /> },
        ]} />
        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-fg-1">{zh ? "分配给任务" : "Allocated to tasks"}</h3>
          {allocations.length === 0 ? <EmptyState size="sm" title={zh ? "还没有任务用这个资金组" : "No task uses this group yet"} description={zh ? "新建任务时选它，任务会在这里排队用额度。" : "Pick it when creating a task; tasks queue here for budget."} /> : (
            <ul className="divide-y divide-line">
              {allocations.map((x) => (
                <li key={`${x.taskId}-${x.mandateId}`} className="flex min-w-0 items-center gap-3 py-2 text-sm">
                  <ToneTag tone={STATE_TONE[x.state] ?? "muted"}>{allocationStateLabel(x.state, zh)}</ToneTag>
                  {x.taskId ? <Link href={`/agent/tasks/${x.taskId}`} className="min-w-0 flex-1 truncate text-sm text-brand-300 hover:underline">{zh ? "打开任务" : "Open task"}</Link> : <span className="min-w-0 flex-1 truncate text-fg-3">{zh ? "任务未返回" : "Task not returned"}</span>}
                  <span className="text-xs text-fg-3 tabular-nums">{zh ? `优先级 ${x.priority}` : `Priority ${x.priority}`}</span>
                  {amt(x.reservedRaw)}
                </li>
              ))}
            </ul>
          )}
        </section>
        <p className="text-xs text-fg-3">{zh ? "不变量：本期已花 + 可执行授权的预留不超过上限。资金组只在本服务内协调，不冻结链上资金，也不覆盖你在别处的钱包操作。" : "Invariant: spent this period + reserved for executable authorizations never exceeds the cap. A budget group coordinates inside this service only; it does not freeze funds on-chain or cover wallet activity elsewhere."}</p>
      </div>
    );
  }

  return (
    <DetailSheet open={Boolean(id)} onOpenChange={onOpenChange}
      title={g?.name ?? (zh ? "资金组" : "Budget group")}
      badges={g && periodEnded(g) ? <ToneTag tone="muted">{zh ? "本期已结束" : "Period over"}</ToneTag> : undefined}>
      {body}
    </DetailSheet>
  );
}
