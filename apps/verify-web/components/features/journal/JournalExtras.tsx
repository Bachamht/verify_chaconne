"use client";
import Link from "next/link";
import { useI18n } from "@/lib/i18n";
import type { RecapView } from "@/lib/api-v2";
import { assetByKey, type AssetEntry } from "@/lib/assets";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/kit/Panel";
import { KeyValue } from "@/components/kit/KeyValue";
import { Timestamp } from "@/components/kit/Timestamp";
import { Hash } from "@/components/kit/Hash";

/** 次要信息：个人里程碑（只按可核对的行为，没有排行榜）+ 可复用的任务结构（只复用结构，不复制金额 / 钱包 / 授权） */
export function JournalExtras({ r, assets }: { r: RecapView; assets: AssetEntry[] }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const sym = (k: string) => assetByKey(assets, k)?.displaySymbol ?? (zh ? "一只股票" : "a stock");
  if (r.milestones.length === 0 && r.remixable.length === 0) return null;
  return (
    <div className="grid min-w-0 gap-4 lg:grid-cols-2">
      <Panel>
        <Panel.Header title={zh ? "个人里程碑" : "Personal milestones"} description={zh ? "只按可核对的行为记录，没有排行榜。" : "Verifiable actions only. No leaderboard."} />
        <Panel.Body>
          {r.milestones.length === 0 ? <p className="text-sm text-fg-3">{zh ? "还没有。" : "None yet."}</p> : (
            <KeyValue items={r.milestones.map((m) => ({ key: m.id, label: m.label[locale], value: <span className="inline-flex items-center gap-2"><Timestamp at={m.at} mode="abs" />{m.evidence.txHash ? <Hash value={m.evidence.txHash} kind="tx" /> : null}</span> }))} />
          )}
        </Panel.Body>
      </Panel>
      <Panel>
        <Panel.Header title={zh ? "可复用的任务结构" : "Reusable task structures"} description={zh ? "只复用结构，不复制金额、钱包或授权。" : "Structure only; no amounts, wallet or authorization are copied."} />
        <Panel.Body>
          {r.remixable.length === 0 ? <p className="text-sm text-fg-3">{zh ? "这一天没有可复用的结构。" : "Nothing reusable this day."}</p> : (
            <ul className="flex flex-col divide-y divide-line">
              {r.remixable.slice(0, 6).map((x) => (
                <li key={x.refId} className="flex min-w-0 items-center justify-between gap-3 py-2.5">
                  <span className="min-w-0 truncate text-sm text-fg-1">
                    {x.structure.side === "buy" ? (zh ? "买入 " : "Buy ") : (zh ? "卖出 " : "Sell ")}{x.structure.outputAssetKeys.map(sym).join(" + ")}
                    {x.structure.steps > 0 ? <span className="text-fg-3">{zh ? ` · ${x.structure.steps} 步` : ` · ${x.structure.steps} steps`}</span> : null}
                  </span>
                  <Button asChild variant="ghost" size="sm"><Link href={x.remixHref}>{zh ? "复用" : "Reuse"}</Link></Button>
                </li>
              ))}
            </ul>
          )}
        </Panel.Body>
      </Panel>
    </div>
  );
}
