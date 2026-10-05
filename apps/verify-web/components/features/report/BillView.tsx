"use client";
import type { Bill } from "@chaconne/core/verify";
import { Amount } from "@/components/kit/Amount";
import { ErrorState, SkeletonRows } from "@/components/kit/FourStates";
import { Hash } from "@/components/kit/Hash";
import { KeyValue } from "@/components/kit/KeyValue";
import { Panel } from "@/components/kit/Panel";
import { ToneTag } from "@/components/kit/StatusBadge";
import { useI18n } from "@/lib/i18n";
import { requestIdOf, type Resource } from "@/lib/useResource";
import { billGroupTitle, billRows, type AssetLite, type BillRow } from "./model";

function RowAmount({ row }: { row: BillRow }) {
  const { locale } = useI18n();
  const a = row.amount;
  if (!a) return <Amount value={null} />;
  if (a.kind === "usd") return row.free ? <span>{locale === "zh" ? "免费" : "Free"}</span> : <Amount value={a.value} prefix="$" maxFrac={2} minFrac={2} />;
  if (a.kind === "units") return <span className="tabular-nums">{Number(a.value).toLocaleString("en-US")}{locale === "zh" ? " 单位" : " units"}</span>;
  return <Amount raw={a.raw} decimals={a.decimals} symbol={a.symbol} maxFrac={4} />;
}

/** 账单：服务费 · 交易本金 · 网络费分组；金额人类单位（服务端给的是原始单位 + 资产地址，在这里换算） */
export function BillView({ res, assets }: { res: Resource<Bill | null>; assets: AssetLite[] | null }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const rows = billRows(res.data, assets, locale);
  const groups = (["fees", "principal", "gas"] as const).map((g) => ({ g, rows: rows.filter((r) => r.group === g) })).filter((x) => x.rows.length > 0);
  return (
    <Panel>
      <Panel.Header
        title={zh ? "账单" : "Bill"}
        description={zh ? "服务费、交易本金与网络费分开记。" : "Service fees, principal and gas are listed separately."}
        action={res.data?.selfPayment ? <ToneTag tone="warn">{zh ? "自付演示" : "Self-paid demo"}</ToneTag> : undefined}
      />
      <Panel.Body>
        {res.state === "loading" || res.state === "idle" ? <SkeletonRows rows={2} /> : res.state === "error" ? (
          <ErrorState size="sm" status={res.status ?? 0} requestId={requestIdOf(res.errorBody)} onRetry={res.reload} title={zh ? "账单暂时读不到" : "Bill unavailable"} />
        ) : groups.length === 0 ? (
          <p className="py-2 text-sm text-fg-2">{zh ? "这条核验没有费用记录。" : "No charges recorded for this verification."}</p>
        ) : groups.map(({ g, rows: rs }) => (
          <div key={g} className="mb-3 last:mb-0">
            <h3 className="text-xs font-medium text-fg-3">{billGroupTitle(g, locale)}</h3>
            <KeyValue dense items={rs.map((r) => ({
              key: r.key,
              label: r.label,
              value: <span className="inline-flex flex-wrap items-center justify-end gap-2"><RowAmount row={r} />{r.txHash ? <Hash value={r.txHash} kind="tx" /> : null}</span>,
            }))} />
          </div>
        ))}
      </Panel.Body>
    </Panel>
  );
}
