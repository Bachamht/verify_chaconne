"use client";
import { useId, type ReactNode } from "react";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

/**
 * 下拉字段：label 在上、说明在下，label 真正关联到 SelectTrigger（kit FormField 只能注入单个控件，Select 根节点接不住 id）。
 */
export function SelectField({ label, hint, value, onChange, options, placeholder, disabled, error, className }: {
  label: ReactNode;
  hint?: ReactNode;
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: ReactNode; disabled?: boolean }>;
  placeholder?: string;
  disabled?: boolean;
  error?: ReactNode;
  className?: string;
}) {
  const id = useId();
  const hintId = hint && !error ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <Label htmlFor={id} className="text-sm font-medium text-fg-1">{label}</Label>
      <Select value={value || undefined} onValueChange={onChange} disabled={disabled}>
        <SelectTrigger id={id} aria-describedby={[hintId, errId].filter(Boolean).join(" ") || undefined} aria-invalid={error ? true : undefined} className="w-full min-w-0"><SelectValue placeholder={placeholder} /></SelectTrigger>
        <SelectContent>
          {options.map((o) => <SelectItem key={o.value} value={o.value} disabled={o.disabled}>{o.label}</SelectItem>)}
        </SelectContent>
      </Select>
      {hint && !error ? <p id={hintId} className="text-xs text-fg-3">{hint}</p> : null}
      {error ? <p id={errId} className="text-xs text-bad">{error}</p> : null}
    </div>
  );
}
