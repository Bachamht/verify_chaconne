"use client";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { FormField } from "@/components/kit/FormField";
import { Panel } from "@/components/kit/Panel";
import type { AssetEntry } from "@/lib/assets";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { AssetPicker } from "./AssetPicker";
import { tf } from "./copy";
import type { FieldErrors, FormDraft } from "./model";

const int = (v: string) => (/^\d+$/.test(v.trim()) ? Number(v) : 0);

/** 第二块：资产 → 资金币种 → 预算 / 单笔 / 笔数 / 天数 → 方向（默认只买入；勾卖出时写明包含原有持仓） */
export function ScopeSection({ value, onChange, stocks, stables, stable, errors, disabled }: {
  value: FormDraft;
  onChange: (patch: Partial<FormDraft>) => void;
  stocks: AssetEntry[];
  stables: AssetEntry[];
  stable: AssetEntry | null;
  errors: FieldErrors;
  disabled?: boolean;
}) {
  const { locale } = useI18n();
  const sym = stable?.displaySymbol ?? "";
  return (
    <Panel>
      <Panel.Header eyebrow={locale === "zh" ? "02 / 委托范围" : "02 / YOUR BOUNDARIES"} title={tf(locale, "limits")} description={tf(locale, "limits_hint")} />
      <Panel.Body className="flex flex-col gap-5">
        <FormField label={tf(locale, "assets")} hint={tf(locale, "assets_hint")} error={errors.assets}>
          <AssetPicker options={stocks} value={value.assetKeys} onChange={(assetKeys) => onChange({ assetKeys })} disabled={disabled} />
        </FormField>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField label={tf(locale, "input_asset")} hint={tf(locale, "input_asset_hint")} error={errors.inputAsset} className="sm:col-span-2">
            <SelectTriggerField value={stable?.assetKey ?? ""} options={stables} disabled={disabled} onValueChange={(inputAssetKey) => onChange({ inputAssetKey })} />
          </FormField>
          <FormField label={`${tf(locale, "total")} · ${sym}`} error={errors.total}>
            <Input inputMode="decimal" maxLength={30} value={value.totalHuman} disabled={disabled} onChange={(e) => onChange({ totalHuman: e.target.value })} className="tabular-nums" />
          </FormField>
          <FormField label={`${tf(locale, "per")} · ${sym}`} error={errors.perStep}>
            <Input inputMode="decimal" maxLength={30} value={value.perStepHuman} disabled={disabled} onChange={(e) => onChange({ perStepHuman: e.target.value })} className="tabular-nums" />
          </FormField>
          <FormField label={tf(locale, "steps")} error={errors.maxSteps}>
            <Input inputMode="numeric" maxLength={3} value={value.maxSteps ? String(value.maxSteps) : ""} disabled={disabled} onChange={(e) => onChange({ maxSteps: int(e.target.value) })} className="tabular-nums" />
          </FormField>
          <FormField label={tf(locale, "days")} error={errors.days}>
            <Input inputMode="numeric" maxLength={3} value={value.days ? String(value.days) : ""} disabled={disabled} onChange={(e) => onChange({ days: int(e.target.value) })} className="tabular-nums" />
          </FormField>
        </div>
        <fieldset className="flex flex-col gap-2" disabled={disabled}>
          <legend className="mb-2 text-sm font-medium text-fg-1">{tf(locale, "direction")}</legend>
          <p className="text-sm text-fg-2">{tf(locale, "buy_only")}</p>
          <div className={cn("flex items-start gap-3 rounded-md border p-3", value.allowSell ? "border-warn/35 bg-surface-warn" : "bg-surface-2")}>
            <Checkbox id="tf-allow-sell" checked={value.allowSell} onCheckedChange={(c) => onChange({ allowSell: c === true })} aria-describedby="tf-allow-sell-hint" className="mt-0.5" />
            <div className="flex min-w-0 flex-col gap-1">
              <Label htmlFor="tf-allow-sell" className="text-sm font-medium text-fg-1">{tf(locale, "allow_sell")}</Label>
              <p id="tf-allow-sell-hint" className={cn("text-xs", value.allowSell ? "text-warn" : "text-fg-3")}>{tf(locale, "allow_sell_hint")}</p>
            </div>
          </div>
        </fieldset>
      </Panel.Body>
    </Panel>
  );
}

/** Select 作为 FormField 的子元素：id / aria 落到 trigger 上 */
function SelectTriggerField({ value, options, onValueChange, disabled, id, "aria-describedby": describedBy, "aria-invalid": invalid }: {
  value: string;
  options: AssetEntry[];
  onValueChange: (v: string) => void;
  disabled?: boolean;
  id?: string;
  "aria-describedby"?: string;
  "aria-invalid"?: boolean;
}) {
  return (
    <Select value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger id={id} aria-describedby={describedBy} aria-invalid={invalid} className="w-full sm:w-60"><SelectValue /></SelectTrigger>
      <SelectContent>
        {options.map((a) => <SelectItem key={a.assetKey} value={a.assetKey}><span translate="no">{a.displaySymbol}</span></SelectItem>)}
      </SelectContent>
    </Select>
  );
}
