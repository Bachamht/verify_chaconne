"use client";
import { useState } from "react";
import { ChevronDown, SlidersHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { FormField } from "@/components/kit/FormField";
import { Panel } from "@/components/kit/Panel";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { tf } from "./copy";
import type { FieldErrors, FormDraft } from "./model";

/** 第三块（默认收起）：策略细节与交易时段。服务端把错误落到这里时自动展开 */
export function ConditionsSection({ value, onChange, errors, disabled }: {
  value: FormDraft;
  onChange: (patch: Partial<FormDraft>) => void;
  errors: FieldErrors;
  disabled?: boolean;
}) {
  const { locale } = useI18n();
  const [open, setOpen] = useState(false);
  const forced = !!(errors.strategy || errors.conditions);
  const isOpen = open || forced;
  return (
    <Collapsible open={isOpen} onOpenChange={setOpen}>
      <Panel>
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" className="h-auto w-full justify-start gap-3 rounded-lg px-5 py-4 text-left">
            <SlidersHorizontal className="text-fg-3" aria-hidden="true" />
            <span className="flex min-w-0 flex-1 flex-col">
              <span className="text-md font-semibold whitespace-normal text-fg-1">{tf(locale, "conditions")}</span>
              <span className="text-sm font-normal whitespace-normal text-fg-2">{tf(locale, "conditions_hint")}</span>
            </span>
            <ChevronDown className={cn("text-fg-3 transition-transform", isOpen && "rotate-180")} aria-hidden="true" />
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <Panel.Body className="flex flex-col gap-5 pt-1">
            <FormField label={tf(locale, "strategy")} error={errors.strategy}>
              <Textarea rows={7} maxLength={4000} value={value.strategy} disabled={disabled} onChange={(e) => onChange({ strategy: e.target.value })} />
            </FormField>
            <div className="flex items-start gap-3">
              <Switch id="tf-regular" checked={value.regularOnly} disabled={disabled} onCheckedChange={(c) => onChange({ regularOnly: c })} aria-describedby="tf-regular-hint" className="mt-0.5" />
              <div className="flex min-w-0 flex-col gap-1">
                <Label htmlFor="tf-regular" className="text-sm font-medium text-fg-1">{tf(locale, "regular")}</Label>
                <p id="tf-regular-hint" className="text-xs text-fg-3">{tf(locale, "regular_hint")}</p>
                {errors.conditions ? <p className="text-xs text-bad">{errors.conditions}</p> : null}
              </div>
            </div>
          </Panel.Body>
        </CollapsibleContent>
      </Panel>
    </Collapsible>
  );
}
