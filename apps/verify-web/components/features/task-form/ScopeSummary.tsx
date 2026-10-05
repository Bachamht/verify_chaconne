"use client";
import { Amount } from "@/components/kit/Amount";
import { KeyValue } from "@/components/kit/KeyValue";
import { Panel } from "@/components/kit/Panel";
import { StatTile } from "@/components/kit/StatTile";
import { ToneTag } from "@/components/kit/StatusBadge";
import { Timestamp } from "@/components/kit/Timestamp";
import type { AssetEntry } from "@/lib/assets";
import { useI18n } from "@/lib/i18n";
import { meaningLines, signatureCount, type FormDraft } from "./model";

const dec = (v: string) => (/^\d+(\.\d+)?$/.test(v.trim()) ? v.trim() : null);

/** 右栏范围摘要：StatTile 竖排（总预算 / 单笔 / 笔数）+ 方向 / 有效期 / 签名 + 「这意味着什么」三行人话 */
export function ScopeSummary({ draft, stable, assets, deadline }: { draft: FormDraft; stable: AssetEntry | null; assets: AssetEntry[]; deadline?: string | null }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const sym = stable?.displaySymbol ?? "";
  const symbolOf = (k: string) => assets.find((a) => a.assetKey.toLowerCase() === k.toLowerCase())?.displaySymbol ?? `…${k.slice(-6)}`;
  const total = dec(draft.totalHuman);
  const per = dec(draft.perStepHuman);
  const lines = meaningLines(draft, sym, locale);
  return (
    <Panel className="ch-scope-summary" aria-label={zh ? "范围摘要" : "Scope summary"}>
      <Panel.Header eyebrow={zh ? "委托摘要" : "YOUR MANDATE"} title={zh ? "你交给它的范围" : "What you are handing over"} description={draft.objective ? <span className="line-clamp-3">{draft.objective}</span> : null} />
      <Panel.Body className="flex flex-col gap-4">
        {draft.assetKeys.length ? (
          <div className="flex flex-wrap gap-1.5">{draft.assetKeys.map((k) => <ToneTag key={k} tone="neutral"><span translate="no">{symbolOf(k)}</span></ToneTag>)}</div>
        ) : <p className="text-sm text-fg-3">{zh ? "还没选股票" : "No stocks chosen yet"}</p>}
        <div className="ch-scope-figures flex flex-col gap-2">
          <StatTile label={zh ? "总预算" : "Total budget"} value={total ? <Amount value={total} symbol={sym} maxFrac={6} /> : null} />
          <StatTile label={zh ? "单笔上限" : "Per-trade cap"} value={per ? <Amount value={per} symbol={sym} maxFrac={6} /> : null} />
          <StatTile label={zh ? "最多成交" : "Maximum fills"} value={draft.maxSteps ? `${draft.maxSteps} ${zh ? "笔" : draft.maxSteps === 1 ? "fill" : "fills"}` : null} />
        </div>
        <KeyValue dense items={[
          { key: "dir", label: zh ? "方向" : "Direction", value: draft.allowSell ? (zh ? "买入，也允许卖出" : "Buy, and may sell") : (zh ? "只买入" : "Buy only") },
          { key: "days", label: zh ? "有效期" : "Valid for", value: deadline ? <Timestamp at={deadline} mode="abs" /> : draft.days ? `${draft.days} ${zh ? "天" : "days"}` : null },
          { key: "sig", label: zh ? "真实运行签名" : "Live signatures", value: zh ? `最多 ${signatureCount(draft)} 次` : `Up to ${signatureCount(draft)}` },
        ]} />
        <section aria-label={zh ? "这意味着什么" : "What this means"} className="flex flex-col gap-2 border-t pt-3">
          <h3 className="text-sm font-medium text-fg-1">{zh ? "这意味着什么" : "What this means"}</h3>
          <ul className="flex list-disc flex-col gap-1.5 pl-4 text-sm text-fg-2 marker:text-fg-3">
            {lines.map((l) => <li key={l}>{l}</li>)}
          </ul>
        </section>
      </Panel.Body>
    </Panel>
  );
}
