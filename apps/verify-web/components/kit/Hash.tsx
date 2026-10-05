"use client";
import { Check, Copy, ExternalLink } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { middleTruncate } from "@/lib/numbers";
import { cn } from "@/lib/utils";
import { EXPLORER } from "@/lib/explorer";
import { useCopy } from "./useCopy";

type Kind = "tx" | "address" | "hash" | "id";

/** 哈希 / 地址 / ID：等宽、中间截断、复制（toast「已复制」）、可选浏览器链接；已命名地址先显示名字 */
export function Hash({ value, kind = "hash", name, explorer = kind === "tx" || kind === "address", head, tail, className }: {
  value: string | null | undefined;
  kind?: Kind;
  name?: string;
  explorer?: boolean;
  head?: number;
  tail?: number;
  className?: string;
}) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const { copied, copy } = useCopy();
  if (!value) return <span className={cn("text-fg-3", className)} title={zh ? "未返回" : "Not returned"}>—</span>;
  const short = middleTruncate(value, head ?? (kind === "id" ? 8 : 6), tail ?? 4);
  const href = explorer ? `${EXPLORER}/${kind === "tx" ? "tx" : "address"}/${value}` : null;
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1 align-middle", className)} translate="no">
      {name ? <span className="truncate text-fg-1">{name}</span> : null}
      <span className={cn("font-mono text-xs", name ? "text-fg-3" : "text-fg-2")} title={value}>{short}</span>
      <button type="button" onClick={() => void copy(value)} className="relative inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-fg-3 after:absolute after:-inset-2 after:content-[''] hover:bg-surface-2 hover:text-fg-1" aria-label={zh ? `复制 ${short}` : `Copy ${short}`}>
        {copied ? <Check className="size-3.5 text-ok" aria-hidden="true" /> : <Copy className="size-3.5" aria-hidden="true" />}
      </button>
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer" className="relative inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-fg-3 after:absolute after:-inset-2 after:content-[''] hover:bg-surface-2 hover:text-brand-300" aria-label={zh ? "在区块浏览器打开" : "Open in explorer"}>
          <ExternalLink className="size-3.5" aria-hidden="true" />
        </a>
      ) : null}
    </span>
  );
}
