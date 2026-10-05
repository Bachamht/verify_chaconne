"use client";
import type { Condition } from "@chaconne/core/verify";
import { useI18n } from "@/lib/i18n";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Panel } from "@/components/kit/Panel";
import { FormField } from "@/components/kit/FormField";
import { vixInvalid } from "./labText";

export interface VariantForm { label: string; afterMin: number; beforeMin: number; wholeDay: boolean; maxVix: string }
export const DEFAULT_A: VariantForm = { label: "A", afterMin: 20, beforeMin: 30, wholeDay: true, maxVix: "" };
export const DEFAULT_B: VariantForm = { label: "B", afterMin: 40, beforeMin: 30, wholeDay: true, maxVix: "" };

/** 表单 → 条件项（两套都固定「只在美股常规时段」） */
export function variantItems(v: VariantForm): Condition[] {
  const items: Condition[] = [
    { type: "session", allow: ["US_REGULAR"] },
    { type: "avoid_event_window", kinds: ["MACRO_TIER1"], beforeMin: v.beforeMin, afterMin: v.afterMin, includeEstimated: true, wholeDayIfDayPrecision: v.wholeDay },
  ];
  const vix = Number(v.maxVix);
  if (v.maxVix.trim() && Number.isFinite(vix) && vix > 0) items.push({ type: "max_vix", value: vix });
  return items;
}

const clampMin = (s: string) => Math.max(0, Math.min(720, Math.round(Number(s) || 0)));

/** 一套规则的编辑框：事件后等待 / 事件前回避 / VIX 上限 / 日期精度时整日等待 */
export function VariantEditor({ id, title, v, onChange }: { id: string; title: string; v: VariantForm; onChange: (v: VariantForm) => void }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const vixBad = vixInvalid(v.maxVix);
  return (
    <Panel as="div" className="bg-surface-2">
      <Panel.Header title={title} level={3} />
      <Panel.Body className="grid gap-3 sm:grid-cols-2">
        <FormField label={zh ? "一级宏观事件后等待（分钟）" : "Wait after tier-1 macro event (min)"}>
          <Input id={`${id}-after`} type="number" inputMode="numeric" min={0} max={720} value={v.afterMin} onChange={(e) => onChange({ ...v, afterMin: clampMin(e.target.value) })} />
        </FormField>
        <FormField label={zh ? "事件前回避（分钟）" : "Avoid before event (min)"}>
          <Input id={`${id}-before`} type="number" inputMode="numeric" min={0} max={720} value={v.beforeMin} onChange={(e) => onChange({ ...v, beforeMin: clampMin(e.target.value) })} />
        </FormField>
        <FormField label={zh ? "VIX 上限" : "Max VIX"} optional={zh ? "（留空 = 不限）" : "(blank = none)"} error={vixBad ? (zh ? "填一个大于 0 的数，或留空。" : "Enter a number above 0, or leave blank.") : undefined}>
          <Input id={`${id}-vix`} inputMode="decimal" value={v.maxVix} onChange={(e) => onChange({ ...v, maxVix: e.target.value })} />
        </FormField>
        <div className="flex items-center gap-3 self-end pb-2">
          <Switch id={`${id}-day`} checked={v.wholeDay} onCheckedChange={(c) => onChange({ ...v, wholeDay: c })} />
          <Label htmlFor={`${id}-day`} className="text-sm text-fg-1">{zh ? "事件只有日期时整日等待" : "Wait all day when only the date is known"}</Label>
        </div>
      </Panel.Body>
    </Panel>
  );
}
