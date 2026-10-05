"use client";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { ConditionsSection } from "./ConditionsSection";
import { ScopeSection } from "./ScopeSection";
import { TemplateSection } from "./TemplateSection";
import { stableOf, type FieldErrors, type FormDraft } from "./model";
import type { TradableAssets } from "./useTradableAssets";

/**
 * 任务表单字段（/start 第 1 步与 /agent/new 共用同一份）：模板 → 资产 → 预算 / 单笔 / 笔数 / 天数 → 方向 → 条件（折叠）。
 * 受控组件：草稿与错误由页面持有；本组件不发请求。
 */
export function TaskFormFields({ value, template, onTemplate, onChange, assets, errors, disabled }: {
  value: FormDraft;
  template: number;
  onTemplate: (i: number) => void;
  onChange: (patch: Partial<FormDraft>) => void;
  assets: TradableAssets;
  errors: FieldErrors;
  disabled?: boolean;
}) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const stable = stableOf(value, assets.assets);
  return (
    <>
      {assets.source === "cache" ? (
        <Alert>
          <AlertDescription className="flex flex-wrap items-center gap-2 text-fg-2">
            {zh ? "资产登记表暂时连不上，当前显示上次缓存的列表。" : "The asset registry is unreachable; showing the last cached list."}
            <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={assets.reload}>{zh ? "重试" : "Retry"}</Button>
          </AlertDescription>
        </Alert>
      ) : null}
      <TemplateSection template={template} onTemplate={onTemplate} value={value} onChange={onChange} errors={errors} disabled={disabled} />
      <ScopeSection value={value} onChange={onChange} stocks={assets.stocks} stables={assets.stables} stable={stable} errors={errors} disabled={disabled} />
      <ConditionsSection value={value} onChange={onChange} errors={errors} disabled={disabled} />
    </>
  );
}
