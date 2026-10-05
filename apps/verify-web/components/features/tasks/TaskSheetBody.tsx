"use client";
import type { NeedsOwnerItem, Task } from "@chaconne/core/verify";
import { Amount } from "@/components/kit/Amount";
import { Blockers, type BlockerItem } from "@/components/kit/Blockers";
import { KeyValue } from "@/components/kit/KeyValue";
import { Timestamp } from "@/components/kit/Timestamp";
import { Skeleton } from "@/components/ui/skeleton";
import { useI18n } from "@/lib/i18n";
import { NextCell, SpentCell } from "./taskColumns";
import type { TaskRow } from "./model";

/** 阻塞项 = 任务自己的 blockers + 服务端 runtime.needsOwner（已按 locale 给了人话） */
export function sheetBlockers(task: Pick<Task, "blockers" | "nextCheckAt"> | null, needs: readonly NeedsOwnerItem[] | null, locale: "zh" | "en"): BlockerItem[] {
  const out: BlockerItem[] = (needs ?? []).map((n) => ({ code: n.code, text: n.text?.[locale] ?? null, level: n.blocking ? "warn" : "wait", needsYou: n.blocking }));
  for (const b of task?.blockers ?? []) out.push({ code: b.code, text: locale === "en" ? b.text ?? null : null, nextCheckAt: task?.nextCheckAt ?? null });
  return out;
}

export function TaskSheetBody({ row, task, steps, needs, loading }: {
  row: TaskRow;
  task: Task | null;
  steps: { planned: number; confirmed: number } | null;
  needs: readonly NeedsOwnerItem[] | null;
  loading: boolean;
}) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const scope = task?.scope;
  const direction = row.side === "sell" ? (zh ? "卖出" : "Sell") : row.allowSell ? (zh ? "买入，允许按策略卖出" : "Buy, selling allowed by strategy") : (zh ? "只买入" : "Buy only");
  const items = sheetBlockers(task, needs, locale);
  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="sheet-summary">
        <h3 id="sheet-summary" className="mb-1 text-sm font-semibold text-fg-1">{zh ? "概要" : "Summary"}</h3>
        <KeyValue dense items={[
          { key: "next", label: zh ? "下一步" : "Next", value: <span className="inline-block max-w-64 text-left"><NextCell row={row} locale={locale} /></span> },
          { key: "stocks", label: zh ? "标的" : "Stocks", value: row.stocks.join("、") || null },
          { key: "dir", label: zh ? "方向" : "Direction", value: direction },
          { key: "steps", label: zh ? "已成交步数" : "Filled steps", value: steps ? <span className="tabular-nums">{steps.confirmed} / {steps.planned}</span> : null, hint: zh ? "只算链上确认" : "On-chain confirmed only" },
          { key: "spent", label: zh ? "预算已用" : "Budget used", value: <SpentCell row={row} locale={locale} /> },
          { key: "per", label: zh ? "每步上限" : "Per-step cap", value: scope?.perStepCapRaw ? <Amount raw={scope.perStepCapRaw} decimals={row.stableDecimals} symbol={row.stableSymbol} maxFrac={2} /> : null },
          { key: "deadline", label: zh ? "有效期至" : "Valid until", value: scope?.deadline ?? task?.goal?.deadline ? <Timestamp at={scope?.deadline ?? task?.goal?.deadline} mode="abs" /> : null },
          { key: "created", label: zh ? "创建" : "Created", value: <Timestamp at={row.createdAt} mode="both" /> },
        ]} />
      </section>
      <section aria-labelledby="sheet-blockers">
        <h3 id="sheet-blockers" className="mb-1 text-sm font-semibold text-fg-1">{zh ? "阻塞项" : "Blockers"}</h3>
        {loading && items.length === 0 ? (
          <div className="flex flex-col gap-2 py-2"><Skeleton className="h-4 w-3/4" /><Skeleton className="h-4 w-1/2" /></div>
        ) : (
          <Blockers items={items} hideNextCheck={row.status === "paused"} empty={<p className="py-2 text-sm text-fg-2">{zh ? "没有阻塞项。" : "Nothing is blocking this task."}</p>} />
        )}
      </section>
    </div>
  );
}
