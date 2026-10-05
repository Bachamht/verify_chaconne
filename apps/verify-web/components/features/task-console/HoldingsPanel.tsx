"use client";
/**
 * 本任务持仓（侧栏 340 宽，用列表而不是表格，数字不截断）：每只股票一行 = 名称 + 本任务净持仓；
 * 次行 = 买入 · 平均成本 ·（允许卖出时）最多可卖。走查：买入任务显示「最多可卖」会误解，所以只在允许卖出时出现，
 * 并注明它等于链上全部余额、可能包含钱包原有持仓。
 */
import type { TaskPosition } from "@/lib/api-v2";
import { Amount } from "@/components/kit/Amount";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/kit/FourStates";
import { Panel } from "@/components/kit/Panel";
import { assetByKey, type AssetEntry } from "@/lib/assets";
import { useI18n } from "@/lib/i18n";

export function HoldingsPanel({ rows, nr, assets, allowSell, onRetry }: { rows: TaskPosition[] | null; nr: number | null; assets: AssetEntry[]; allowSell: boolean; onRetry: () => void }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const sym = (k: string) => assetByKey(assets, k)?.displaySymbol ?? (zh ? "未知资产" : "Unknown asset");
  const dec = (k: string) => assetByKey(assets, k)?.tokenDecimals ?? null;
  return (
    <Panel aria-label={zh ? "本任务持仓" : "Task holdings"}>
      <Panel.Header title={zh ? "本任务持仓" : "Task holdings"} />
      <Panel.Body>
        {nr !== null ? <ErrorState size="sm" status={nr} onRetry={onRetry} />
          : rows === null ? <LoadingBlock rows={2} onRetry={onRetry} />
          : rows.length === 0 ? <EmptyState size="sm" title={zh ? "还没有本任务的持仓" : "No holdings from this task yet"} description={zh ? "成交在链上确认后会出现在这里。" : "Holdings appear once a fill is confirmed on-chain."} />
          : (
          <ul className="flex flex-col divide-y divide-line">
            {rows.map((p) => (
              <li key={p.assetKey} className="flex flex-col gap-1 py-2.5 first:pt-0 last:pb-0">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="font-medium text-fg-1">{sym(p.assetKey)}</span>
                  <Amount raw={p.netRaw} decimals={dec(p.assetKey)} maxFrac={6} className="text-fg-1" />
                </div>
                <p className="flex flex-wrap gap-x-3 text-xs text-fg-3">
                  <span>{zh ? "买入 " : "Bought "}<Amount raw={p.boughtRaw ?? null} decimals={dec(p.assetKey)} maxFrac={6} /></span>
                  <span>{zh ? "均价 " : "Avg "}<Amount value={p.avgCostUsd ?? null} prefix="$" maxFrac={2} minFrac={2} /></span>
                  {allowSell ? <span>{zh ? "最多可卖 " : "Max sellable "}<Amount raw={p.sellableRaw ?? null} decimals={dec(p.assetKey)} maxFrac={6} /></span> : null}
                </p>
              </li>
            ))}
          </ul>
        )}
        {allowSell && rows && rows.length > 0 ? <p className="mt-3 text-xs text-fg-3">{zh ? "「最多可卖」等于钱包里这只股票的全部链上余额，可能包含你原有的持仓。" : "Max sellable equals the wallet's whole on-chain balance of that stock and may include coins you already held."}</p> : null}
      </Panel.Body>
    </Panel>
  );
}
