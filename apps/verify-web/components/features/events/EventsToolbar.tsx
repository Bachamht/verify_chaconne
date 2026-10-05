"use client";
/** 工具条：范围 24/48/72h（分段按钮）· 只看相关（开关）· 资产筛选（下拉）。三者都写进 URL（调用方用 useQueryState）。 */
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Segmented } from "@/components/kit/Toggles";
import { useI18n } from "@/lib/i18n";
import { copy } from "./copy";

export const RANGES = [24, 48, 72] as const;

export function EventsToolbar({ hours, onHours, relevant, onRelevant, asset, onAsset, assetOptions }: {
  hours: number;
  onHours: (h: number) => void;
  relevant: boolean;
  onRelevant: (v: boolean) => void;
  asset: string;
  onAsset: (symbol: string) => void;
  assetOptions: string[];
}) {
  const { locale } = useI18n();
  const c = copy(locale);
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-3">
      <Segmented label={c("range")} value={hours} onChange={onHours} options={RANGES.map((h) => ({ value: h, label: `${h}${locale === "zh" ? " 小时" : "h"}` }))} />
      <div className="flex items-center gap-2">
        <Switch id="ev-relevant" checked={relevant} onCheckedChange={onRelevant} />
        <Label htmlFor="ev-relevant" className="text-sm text-fg-1">{c("only_relevant")}</Label>
      </div>
      {/* 原生 select：Radix Select + 浮层定位约 60 KB，工具条用不着；Windows 暗色显式给底色与字色（E2） */}
      <select
        aria-label={c("asset")}
        value={asset}
        onChange={(e) => onAsset(e.target.value)}
        className="h-8 w-40 rounded-md border border-input bg-surface-1 px-2 text-sm text-fg-1 hover:border-line-strong focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none"
      >
        <option value="" className="bg-surface-1 text-fg-1">{c("all_assets")}</option>
        {assetOptions.map((s) => <option key={s} value={s} className="bg-surface-1 text-fg-1" translate="no">{s}</option>)}
      </select>
    </div>
  );
}
