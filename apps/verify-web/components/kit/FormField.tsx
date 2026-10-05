"use client";
import { useId, type ReactElement, type ReactNode } from "react";
import { cloneElement } from "react";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";

/**
 * 表单字段：label 在上、说明在下、错误在下（A5）；错误用 aria-describedby 关联，aria-invalid 标红。
 * children 必须是单个输入控件（Input / Textarea / SelectTrigger…），本组件给它注入 id 与 aria 属性。
 */
export function FormField({ label, hint, error, children, className, optional }: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactElement<{ id?: string; "aria-describedby"?: string; "aria-invalid"?: boolean }>;
  className?: string;
  optional?: ReactNode;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  const describedBy = [hintId, errId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <Label htmlFor={id} className="text-sm font-medium text-fg-1">
        {label}
        {optional ? <span className="ml-1 font-normal text-fg-3">{optional}</span> : null}
      </Label>
      {cloneElement(children, { id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
      {hint && !error ? <p id={hintId} className="text-xs text-fg-3">{hint}</p> : null}
      {error ? <p id={errId} className="text-xs text-bad">{error}</p> : null}
    </div>
  );
}
