"use client";
import type { ReactNode } from "react";
import { useI18n } from "@/lib/i18n";

/**
 * 检查项描述：先给人话（children），再把原始 id 与验证器原文放进「技术细节」折叠（开发者核对用，默认收起）。
 */
export function CheckDetail({ id, detail, children }: { id: string; detail: string; children: ReactNode }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  return (
    <span className="flex min-w-0 flex-col gap-1 text-xs leading-5 text-fg-2">
      <span>{children}</span>
      <details className="text-fg-3">
        <summary className="cursor-pointer select-none">{zh ? "技术细节" : "Technical detail"}</summary>
        <code className="block font-mono break-all" translate="no">{id}{detail ? ` · ${detail}` : ""}</code>
      </details>
    </span>
  );
}
