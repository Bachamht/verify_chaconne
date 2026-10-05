"use client";
import Link from "next/link";
import { CircleCheck, CircleDashed } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/kit/Panel";
import { EmptyState } from "@/components/kit/FourStates";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { NeedItem } from "./model";

const MAX = 6;

/** 需要你处理：每条 = 一句人话 + 所属任务 + 一个主动作 */
export function NeedsPanel({ items, partial }: { items: NeedItem[]; partial: boolean }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const shown = items.slice(0, MAX);
  return (
    <Panel tone={items.length > 0 ? "warn" : "default"} aria-label={zh ? "需要你处理" : "Needs you"}>
      <Panel.Header
        title={zh ? "需要你处理" : "Needs you"}
        description={partial && shown.length > 0 ? (zh ? "有任务的状态没取到，清单可能不全。" : "Some task states did not load; the list may be incomplete.") : undefined}
        action={items.length > MAX ? <Button asChild variant="link" size="sm" className="h-auto p-0"><Link href="/agent/tasks">{zh ? `全部 ${items.length} 条` : `All ${items.length}`}</Link></Button> : null}
      />
      <Panel.Body>
        {shown.length === 0 && partial ? (
          <EmptyState size="sm" art={<CircleDashed className="size-6 text-fg-3" strokeWidth={1.5} aria-hidden="true" />} title={zh ? "清单没取全，暂时不能说没有待办" : "The list did not fully load; cannot say nothing needs you"} description={zh ? "有任务的状态没拿到。到任务列表逐个看，或稍后刷新。" : "Some task states did not load. Check the task list, or refresh shortly."} action={<Button asChild size="sm" variant="outline"><Link href="/agent/tasks">{zh ? "看任务列表" : "Open the task list"}</Link></Button>} />
        ) : shown.length === 0 ? (
          <EmptyState size="sm" art={<CircleCheck className="size-6 text-ok" strokeWidth={1.5} aria-hidden="true" />} title={zh ? "现在没有要你处理的事" : "Nothing needs you right now"} description={zh ? "Agent 在签好的范围内自己推进；有需要会出现在这里。" : "The agent works inside the signed scope; anything that needs you shows up here."} />
        ) : (
          <ul className="flex flex-col divide-y divide-line">
            {shown.map((n, i) => (
              <li key={n.key} className="flex min-w-0 flex-col gap-2 py-3 sm:flex-row sm:items-center sm:gap-4">
                <span className={cn("hidden size-2 shrink-0 rounded-full sm:block", n.blocking ? "bg-warn" : "bg-info")} aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="text-sm text-fg-1">{n.text}</p>
                  <p className="truncate text-xs text-fg-3" title={n.title}>{n.title}</p>
                </div>
                <Button asChild size="sm" variant={i === 0 && n.blocking ? "default" : "outline"} className="self-start sm:self-auto">
                  <Link href={n.action.href}>{n.action.label}</Link>
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Panel.Body>
    </Panel>
  );
}
