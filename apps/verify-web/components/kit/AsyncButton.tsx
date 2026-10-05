"use client";
import type { ComponentProps, ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * 异步按钮三态（C1）：idle → pending（文案 + spinner，禁用）→ 结果由调用方 toast / 行内展示。
 * disabledReason：禁用时必须给可见原因（C3），显示在按钮下方。
 */
export function AsyncButton({ pending, pendingLabel, children, disabledReason, disabled, ...rest }: ComponentProps<typeof Button> & {
  pending?: boolean;
  pendingLabel?: ReactNode;
  disabledReason?: ReactNode;
}) {
  const btn = (
    <Button {...rest} disabled={disabled || pending} aria-busy={pending || undefined}>
      {pending ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
      {pending && pendingLabel ? pendingLabel : children}
    </Button>
  );
  if (!disabled || !disabledReason) return btn;
  return (
    <span className="inline-flex min-w-0 max-w-full flex-col items-start gap-1">
      {btn}
      <span className="text-xs text-fg-3">{disabledReason}</span>
    </span>
  );
}
