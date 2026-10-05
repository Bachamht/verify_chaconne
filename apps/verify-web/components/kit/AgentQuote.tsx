"use client";
/**
 * Agent 原话（引用，不改写）：标明是原话；中文页遇到非中文原文时写「英文原文，未翻译」（语言跟随它的策略）。
 * 长段落先收起（2 或 4 行），可展开；中英混排长串用 overflow-wrap:anywhere 防撑破。
 * 控制台活动流、日志回执、今天页共用这一份（此前三处各写一份）。
 */
import { useState, type ReactNode } from "react";
import { useI18n } from "@/lib/i18n";
import type { Locale } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export function agentQuoteLabel(text: string, locale: Locale, kind: "said" | "nextIf" = "said"): string {
  const zh = locale === "zh";
  const head = kind === "nextIf" ? (zh ? "Agent 原话 · 什么情况下再行动" : "Agent's own words · when it would act") : (zh ? "Agent 原话" : "Agent's own words");
  return zh && !/[一-鿿]/.test(text) ? `${head}（英文原文，未翻译）` : head;
}

const CLAMP: Record<2 | 4, string> = { 2: "line-clamp-2", 4: "line-clamp-4" };

export function AgentQuote({ text, kind = "said", lines = 2, meta, className }: {
  text: string;
  kind?: "said" | "nextIf";
  /** 收起时显示几行 */
  lines?: 2 | 4;
  /** 右上角：时间等 */
  meta?: ReactNode;
  className?: string;
}) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const [open, setOpen] = useState(false);
  const long = text.length > (lines === 2 ? 140 : 240);
  return (
    <blockquote className={cn("min-w-0 rounded-sm border-l-2 border-l-brand-400 bg-surface-brand px-3 py-2 text-sm text-fg-1", className)}>
      <span className="mb-0.5 flex items-center justify-between gap-3 text-xs text-brand-300">
        <span>{agentQuoteLabel(text, locale, kind)}</span>
        {meta ? <span className="shrink-0 text-fg-3">{meta}</span> : null}
      </span>
      <span className={cn("block break-words whitespace-pre-line [overflow-wrap:anywhere]", long && !open && CLAMP[lines])} lang={/[一-鿿]/.test(text) ? undefined : "en"}>{text}</span>
      {long ? (
        <button type="button" className="mt-0.5 text-xs text-brand-400 hover:text-brand-300" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? (zh ? "收起" : "Show less") : (zh ? "展开全文" : "Show all")}
        </button>
      ) : null}
    </blockquote>
  );
}
