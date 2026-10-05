"use client";
import { Check, Copy } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { useCopy } from "./useCopy";

/** 代码 / 原始 JSON：等宽、自身横向滚动（不撑破页面）、复制按钮 */
export function CodeBlock({ code, language, className, maxHeight = "md" }: {
  code: string;
  language?: string;
  className?: string;
  maxHeight?: "sm" | "md" | "none";
}) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const { copied, copy } = useCopy();
  return (
    <div className={cn("relative min-w-0 rounded-md border bg-surface-0", className)} translate="no">
      <div className="flex items-center justify-between gap-2 border-b px-3 py-1.5">
        <span className="text-xs text-fg-3">{language ?? ""}</span>
        <button type="button" onClick={() => void copy(code)} className="inline-flex h-7 items-center gap-1 rounded-sm px-2 text-xs text-fg-2 hover:bg-surface-2 hover:text-fg-1">
          {copied ? <Check className="size-3.5 text-ok" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
          {zh ? "复制" : "Copy"}
        </button>
      </div>
      <pre className={cn("overflow-auto p-3 font-mono text-xs leading-5 text-fg-2", maxHeight === "sm" ? "max-h-48" : maxHeight === "md" ? "max-h-96" : "")} tabIndex={0}>
        <code>{code}</code>
      </pre>
    </div>
  );
}
