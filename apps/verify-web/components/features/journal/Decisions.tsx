"use client";
import Link from "next/link";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { RecapView } from "@/lib/api-v2";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/kit/Panel";
import { blockerText } from "@/components/kit/Blockers";
import { StatusBadge } from "@/components/kit/StatusBadge";
import { playbookTitle } from "@/components/agent/tasks/taskTitle";
import { decisionHref, decisionLabel, decisionState, decisionText } from "./receipts";

type Decision = RecapView["sections"]["decisions"][number];

/** 需要你决定：一句中文短句 + 哪个任务 + 一个去处理的链接。服务端英文 text 只在英文页用 */
export function Decisions({ items, titles, live }: { items: Decision[]; titles: Map<string, string>; live: ReadonlyMap<string, string> | null }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  if (items.length === 0) return null;
  // 按实时状态核一遍：已处理 / 已删除的排到后面、不再给按钮
  const rows = items.map((d) => ({ d, state: decisionState(d, live) })).sort((a, b) => Number(a.state !== "open") - Number(b.state !== "open"));
  const open = rows.filter((r) => r.state === "open").length;
  return (
    <Panel tone={open > 0 ? "warn" : "default"} aria-label={zh ? "需要你决定" : "Needs your decision"}>
      <Panel.Header title={zh ? "需要你决定" : "Needs your decision"} description={open > 0 ? (zh ? "这些事 Agent 不能替你做。" : "The agent cannot do these for you.") : (zh ? "当天记下的事项现在都已处理。" : "Everything recorded that day has since been handled.")} />
      <Panel.Body>
        <ul className="flex flex-col divide-y divide-line">
          {rows.map(({ d, state }, i) => {
            const text = decisionText(d.code, locale) ?? blockerText({ code: d.code, text: zh ? null : d.text }, locale);
            const name = titles.get(d.refId) ?? (d.refId.startsWith("mnd_") ? (zh ? "早期授权计划" : "Earlier authorization plan") : playbookTitle(d.label, locale));
            return (
              <li key={`${d.refId}:${d.code}:${i}`} className={cn("flex min-w-0 flex-wrap items-start gap-x-4 gap-y-2 py-3", state !== "open" && "opacity-60")} title={d.code}>
                <div className="min-w-0 flex-1 basis-full sm:basis-0">
                  <p className="text-sm break-words text-fg-1">{text}</p>
                  <p className="mt-0.5 truncate text-xs text-fg-3">{name}</p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {state === "open" ? (
                    <>
                      <StatusBadge status="needs_you" />
                      <Button asChild variant="outline" size="sm">
                        <Link href={decisionHref(d)}>{decisionLabel(d.action, locale)}</Link>
                      </Button>
                    </>
                  ) : (
                    <span className="text-xs text-fg-3">{state === "deleted" ? (zh ? "任务已删除" : "Task removed") : (zh ? "已处理" : "Handled")}</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </Panel.Body>
    </Panel>
  );
}
