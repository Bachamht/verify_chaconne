"use client";
import { Skeleton } from "@/components/ui/skeleton";
import { Amount } from "@/components/kit/Amount";
import { NotReturned } from "@/components/kit/NotReturned";
import { KpiRow, StatTile } from "@/components/kit/StatTile";
import { useI18n } from "@/lib/i18n";
import type { FundsKpis as Kpis } from "./fundsModel";

const usd = (v: string | null) => (v === null ? <NotReturned className="text-md font-medium" /> : <Amount value={v} prefix="$" maxFrac={2} minFrac={2} />);

export function FundsKpis({ kpis, loading, readingChain }: { kpis: Kpis; loading: boolean; readingChain: boolean }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  if (loading) {
    return (
      <KpiRow className="lg:grid-cols-3">
        {[0, 1, 2].map((i) => <Skeleton key={i} className="h-24 rounded-lg" />)}
      </KpiRow>
    );
  }
  const reading = zh ? "正在直读链上余额" : "Reading balances on-chain";
  return (
    <KpiRow className="lg:grid-cols-3">
      <StatTile
        label={zh ? "可用" : "Available"}
        value={usd(kpis.available)}
        hint={kpis.available === null ? (readingChain ? reading : zh ? "链上余额读取失败，不当作 0" : "On-chain read failed; not treated as 0") : (zh ? "稳定币按 1 美元计" : "Stablecoins at $1")}
      />
      <StatTile
        label={zh ? "已授权" : "Authorized"}
        value={usd(kpis.authorized)}
        hint={zh ? "给 PlanGuard 合约的链上额度" : "On-chain allowance to PlanGuard"}
      />
      <StatTile
        label={zh ? "持仓市值" : "Holdings value"}
        value={usd(kpis.marketValue)}
        hint={kpis.marketValue === null ? (readingChain ? reading : zh ? "有持仓余额或价格没拿到" : "A balance or price is missing") : (zh ? "余额 × 市场参考价" : "Balance × market reference price")}
      />
    </KpiRow>
  );
}
