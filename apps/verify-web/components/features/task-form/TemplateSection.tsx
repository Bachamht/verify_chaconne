"use client";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "@/components/kit/FormField";
import { Panel } from "@/components/kit/Panel";
import { useI18n } from "@/lib/i18n";
import { tf } from "./copy";
import { TEMPLATES, type FieldErrors, type FormDraft } from "./model";

/** 目标先行，示例用于起草。换示例会重置目标、策略、股票与上限（保留资金币种）。 */
export function TemplateSection({ template, onTemplate, value, onChange, errors, disabled }: {
  template: number;
  onTemplate: (i: number) => void;
  value: FormDraft;
  onChange: (patch: Partial<FormDraft>) => void;
  errors: FieldErrors;
  disabled?: boolean;
}) {
  const { locale } = useI18n();
  return (
    <Panel className="ch-task-objective">
      <Panel.Header eyebrow={locale === "zh" ? "01 / 你的想法" : "01 / YOUR INTENT"} title={tf(locale, "objective")} description={tf(locale, "objective_hint")} />
      <Panel.Body className="flex flex-col gap-5">
        <FormField label={tf(locale, "objective")} error={errors.objective}>
          <Textarea className="ch-objective-input" rows={4} maxLength={500} value={value.objective} disabled={disabled} onChange={(e) => onChange({ objective: e.target.value })} />
        </FormField>
        <div className="border-t pt-5">
          <h3 className="text-sm font-medium text-fg-1">{locale === "zh" ? "也可以从一个示例开始" : "Or start with an example"}</h3>
          <p className="mt-1 text-xs leading-relaxed text-fg-3">{tf(locale, "template_hint")}</p>
        </div>
        <RadioGroup value={String(template)} onValueChange={(v) => onTemplate(Number(v))} disabled={disabled} className="ch-strategy-options grid gap-2 sm:grid-cols-2" aria-label={tf(locale, "template")}>
          {TEMPLATES.map((t, i) => (
            <Label key={t.id} htmlFor={`tpl-${t.id}`} className="flex min-w-0 cursor-pointer items-start gap-3 rounded-md border bg-surface-2 p-3 font-normal hover:border-line-strong has-[[data-state=checked]]:border-line-brand has-[[data-state=checked]]:bg-surface-brand">
              <RadioGroupItem id={`tpl-${t.id}`} value={String(i)} className="mt-0.5" />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="text-sm font-medium text-fg-1">{t.title[locale]}</span>
                <span className="line-clamp-2 text-xs text-fg-3">{t.space[locale]}</span>
              </span>
            </Label>
          ))}
        </RadioGroup>
      </Panel.Body>
    </Panel>
  );
}
