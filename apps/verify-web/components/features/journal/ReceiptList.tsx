"use client";
import Link from "next/link";
import { useI18n } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/kit/Panel";
import { EmptyState } from "@/components/kit/FourStates";
import type { Receipt } from "./receipts";
import { ReceiptItem } from "./ReceiptItem";

/** 回执列表：新的在上；空 = 这一天 Agent 没有动作（写清是「真的没有」） */
export function ReceiptList({ receipts, titles, hasAgent }: { receipts: Receipt[]; titles: Map<string, string>; hasAgent: boolean }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  return (
    <Panel aria-label={zh ? "回执" : "Receipts"}>
      <Panel.Header
        title={`${zh ? "回执" : "Receipts"} · ${receipts.length}`}
      />
      <Panel.Body>
        {receipts.length === 0 ? (
          <EmptyState
            size="sm"
            title={hasAgent ? (zh ? "这一天 Agent 没有动作" : "The agent took no action this day") : (zh ? "这份日志没有 Agent 记录" : "This journal has no agent records")}
            description={hasAgent ? (zh ? "没有成交、没有签发，也没有等待记录。" : "No fills, no certificates and no waits were recorded.") : (zh ? "可能是当天没有 Agent 任务，或生成时还没接入。可以点「重新生成」。" : "There may have been no agent task that day, or it was not connected when generated. Try Regenerate.")}
            action={<Button asChild variant="outline" size="sm"><Link href="/agent/tasks">{zh ? "看我的任务" : "Open my tasks"}</Link></Button>}
          />
        ) : (
          <ol className="flex flex-col divide-y divide-line">
            {receipts.map((r) => <ReceiptItem key={r.id} r={r} title={r.taskId ? titles.get(r.taskId) ?? null : null} />)}
          </ol>
        )}
      </Panel.Body>
    </Panel>
  );
}
