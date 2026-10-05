"use client";
import Link from "next/link";
import { useI18n } from "@/lib/i18n";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SourceChip } from "@/components/kit/AgentSays";
import { Hash } from "@/components/kit/Hash";
import { ToneTag } from "@/components/kit/StatusBadge";
import { Timestamp } from "@/components/kit/Timestamp";
import { TONE_DOT } from "@/components/kit/tone";
import { cn } from "@/lib/utils";
import { revocableMeta, type Receipt } from "./receipts";
import { AgentQuote } from "./AgentQuote";

/**
 * 一条回执：时间 | 动作 + 变了什么 + 任务 / 证据 chip + Agent 原话 | 可撤销？
 * 手机单栏：时间与标签在上一行。长段落 break-words，正文行宽 ≤ 72ch。
 */
export function ReceiptItem({ r, title }: { r: Receipt; title: string | null }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const rev = revocableMeta(r.revocable, locale);
  return (
    <li className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 py-4 sm:grid-cols-[6.5rem_minmax(0,1fr)_auto]">
      <span className="col-span-1 flex items-center gap-2 text-xs text-fg-3 sm:col-span-1 sm:pt-0.5">
        <span className={cn("size-2 shrink-0 rounded-full", TONE_DOT[r.tone])} aria-hidden="true" />
        <Timestamp at={r.at} mode="abs" />
      </span>
      <span className="col-start-2 row-start-1 justify-self-end sm:col-start-3">
        <Tooltip>
          <TooltipTrigger asChild>
            <button type="button" className="rounded-sm focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none" aria-label={`${rev.label}：${rev.hint}`}>
              <ToneTag tone={rev.tone}>{rev.label}</ToneTag>
            </button>
          </TooltipTrigger>
          <TooltipContent className="max-w-72">{rev.hint}</TooltipContent>
        </Tooltip>
      </span>
      <div className="col-span-2 flex min-w-0 max-w-[72ch] flex-col gap-1.5 sm:col-span-1 sm:col-start-2 sm:row-start-1">
        <p className="text-base font-medium break-words text-fg-1">{r.action}</p>
        <p className="text-sm break-words text-fg-2">
          <span className="text-fg-3">{zh ? "变化：" : "Changed: "}</span>{r.changed}
        </p>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-fg-3">
          {r.taskId ? (
            <Link href={`/agent/tasks/${r.taskId}`} className="min-w-0 truncate text-fg-2 hover:text-brand-300">{title ?? (zh ? "打开任务" : "Open task")}</Link>
          ) : null}
          {r.evidence.kind === "tx" ? (
            <span className="inline-flex items-center gap-1">{zh ? "交易" : "Tx"} <Hash value={r.evidence.value} kind="tx" /></span>
          ) : r.evidence.kind === "intent" && r.taskId ? (
            <SourceChip href={`/agent/tasks/${r.taskId}`}>{zh ? "意图与核验记录" : "Intent and checks"}</SourceChip>
          ) : (
            <span>{zh ? "无链上证据（没有交易）" : "No on-chain evidence (no transaction)"}</span>
          )}
        </div>
        {r.quote ? <AgentQuote text={r.quote} kind="said" /> : null}
        {r.nextIf ? <AgentQuote text={r.nextIf} kind="nextIf" /> : null}
      </div>
    </li>
  );
}
