"use client";
/**
 * /agent/funds（v8，方案 §5.8）：KPI（可用 / 已授权 / 持仓市值）+ 资产与额度表（#allowances，行尾「收回」）。
 * 资金组（「预留」与资金组列表）普通流程用不到，10/5 起页面上不再显示；接口与组件保留（BudgetGroups.tsx）。
 * 没拿到的数显示「未返回」，绝不补 0；收回额度是链上授权变更，必须二次确认。
 */
import { useEffect, useRef, useState } from "react";
import { ErrorState, EmptyState, LoadingBlock } from "@/components/kit/FourStates";
import { PageHeader } from "@/components/kit/PageHeader";
import { Panel } from "@/components/kit/Panel";
import { Timestamp } from "@/components/kit/Timestamp";
import { useI18n } from "@/lib/i18n";
import { requestIdOf } from "@/lib/useResource";
import { AllowanceFootnote, AssetTable } from "./AssetTable";
import { FundsKpis } from "./FundsKpis";
import { ReclaimDialog } from "./ReclaimDialog";
import type { AssetRow } from "./fundsModel";
import { useFundsData } from "./useFundsData";

export function FundsPage() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const d = useFundsData();
  const [reclaiming, setReclaiming] = useState<AssetRow | null>(null);
  const loading = d.pf.state === "loading" || d.al.state === "loading" || d.pf.state === "idle";
  const bothFailed = d.pf.state === "error" && d.al.state === "error";
  const block = d.pf.data?.block;

  // 任务页链到 /agent/funds#allowances：数据是异步渲染的，到了再滚一次
  const scrolled = useRef(false);
  useEffect(() => {
    if (loading || scrolled.current || typeof window === "undefined" || window.location.hash !== "#allowances") return;
    scrolled.current = true;
    document.getElementById("allowances")?.scrollIntoView({ block: "start" });
  }, [loading]);

  let table;
  if (loading) table = <div className="px-5 pb-5"><LoadingBlock rows={5} onRetry={() => { d.pf.reload(); d.al.reload(); }} /></div>;
  else if (bothFailed) table = <ErrorState size="sm" status={d.pf.status ?? 0} requestId={requestIdOf(d.pf.errorBody)} onRetry={() => { d.pf.reload(); d.al.reload(); }} title={zh ? "余额与额度都没有拿到" : "Balances and allowances did not load"} />;
  else if (d.rows.length === 0) table = <EmptyState size="sm" title={zh ? "这个钱包还没有资金币种或持仓记录" : "No funding currency or holding on record for this wallet"} description={zh ? "往钱包里转入 USDG 等稳定币后，这里会显示余额与给合约的额度。" : "After you move a stablecoin such as USDG into the wallet, balances and contract allowances show here."} />;
  else {
    table = (
      <div className="flex flex-col gap-3">
        {d.pf.state === "error" ? <p role="status" className="px-5 text-sm text-warn">{zh ? "余额没有拿到，下面只显示额度；余额列是「未返回」，不是 0。" : "Balances did not load; only allowances are shown. \"Not returned\" is not 0."}</p> : null}
        {d.al.state === "error" ? <p role="status" className="px-5 text-sm text-warn">{zh ? "PlanGuard 额度没有拿到，暂时不能收回；稍后刷新。" : "PlanGuard allowances did not load, so reclaiming is unavailable for now. Refresh shortly."}</p> : null}
        <div className="px-4 sm:px-0"><AssetTable rows={d.rows} allowancesMissing={d.al.state === "error"} readingChain={d.readingChain} onReclaim={setReclaiming} /></div>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader
        title={zh ? "资金" : "Funds"}
        className="mb-0"
      />
      <FundsKpis kpis={d.kpis} loading={loading} readingChain={d.readingChain} />
      <Panel id="allowances" className="scroll-mt-20">
        <Panel.Header
          title={zh ? "资产与额度" : "Assets and allowances"}
          description={block ? (
            <span className="inline-flex flex-wrap items-center gap-x-1">
              {zh ? "余额截至区块" : "Balances as of block"} <span className="tabular-nums">{String(block.number)}</span>
              {block.timestamp ? <><span aria-hidden="true">·</span><Timestamp at={block.timestamp} mode="rel" /></> : null}
            </span>
          ) : (zh ? "余额来自链上；额度是你的钱包允许 PlanGuard 合约动用的量。" : "Balances come from the chain; allowances are what your wallet lets the PlanGuard contract move.")}
        />
        <Panel.Body flush className="pb-4">{table}</Panel.Body>
        <Panel.Footer><AllowanceFootnote /></Panel.Footer>
      </Panel>
      {d.owner ? <ReclaimDialog row={reclaiming} owner={d.owner} onOpenChange={(o) => { if (!o) setReclaiming(null); }} onDone={() => d.al.reload()} /> : null}
    </div>
  );
}
