"use client";
/**
 * 「需要你」：runtime.needsOwner（阻塞在前，提醒在后）+ 平台在处理的事（needsOperator，不需要你操作）。
 * 待办未返回时明说「未返回」，不写「没有待办」。每条一个动作。
 */
import Link from "next/link";
import type { NeedsOwnerItem, TaskRuntime } from "@chaconne/core/verify";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/kit/Panel";
import { ToneTag } from "@/components/kit/StatusBadge";
import { sortNeedsOwner } from "@/components/agent/tasks/v7/runtimeModel";
import { useV7 } from "@/components/agent/tasks/v7/useV7";
import { needExternalHref } from "@/components/features/common/needsAction";

export function NeedsPanel({ runtime, onAction }: { runtime: TaskRuntime | null; onAction: (item: NeedsOwnerItem) => void }) {
  const { s, m, locale, zh } = useV7();
  const known = Array.isArray(runtime?.needsOwner);
  const needs = sortNeedsOwner(runtime?.needsOwner);
  const ops = runtime?.needsOperator ?? [];
  const blocking = needs.some((n) => n.blocking);
  return (
    <Panel tone={blocking ? "warn" : "default"} aria-label={s("q4_h")}>
      <Panel.Header title={s("q4_h")} action={needs.length > 0 ? <span className="text-sm text-fg-2 tabular-nums">{needs.length}</span> : undefined} />
      <Panel.Body className="flex flex-col gap-3">
        {ops.length > 0 ? <p className="rounded-md border border-info/35 bg-info/12 px-3 py-2 text-sm text-fg-1">{s("q4_operator", { what: ops.map((o) => m(`op_${o}`) ?? (zh ? "平台事务" : "platform issue")).join(zh ? "、" : ", ") })}</p> : null}
        {!known ? <p className="text-sm text-fg-2">{zh ? "待办状态尚未返回，确认后再判断是否需要你操作。" : "Your action list has not arrived yet."}</p>
          : needs.length === 0 ? <p className="text-sm text-fg-2">{s("q4_none")}</p> : (
          <ul className="flex flex-col divide-y divide-line">
            {needs.map((n, i) => (
              <li key={`${n.code}-${i}`} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0">
                <div className="flex items-start gap-2">
                  <ToneTag tone={n.blocking ? "warn" : "info"}>{n.blocking ? s("no_blocking") : s("no_reminder")}</ToneTag>
                  <p className="min-w-0 text-sm text-fg-1">{n.text[locale]}</p>
                </div>
                <NeedAction item={n} onAction={onAction} label={m(`no_action_${n.action.kind}`) ?? (zh ? "去处理" : "Handle it")} />
              </li>
            ))}
          </ul>
        )}
      </Panel.Body>
    </Panel>
  );
}

function NeedAction({ item, onAction, label }: { item: NeedsOwnerItem; onAction: (i: NeedsOwnerItem) => void; label: string }) {
  const href = needExternalHref(item.action.kind);
  if (href) return <Button asChild size="sm" variant="outline" className="self-start"><Link href={href}>{label}</Link></Button>;
  return <Button size="sm" variant={item.blocking ? "default" : "outline"} className="self-start" onClick={() => onAction(item)}>{label}</Button>;
}
