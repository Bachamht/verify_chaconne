"use client";
import Link from "next/link";
import { newTaskHref } from "@/components/features/new-task/href";
/**
 * 抽屉底部动作：一个主动作「预览条件变更」+「更多」（其余事件动作，作用于具体任务的逐个列出）。
 * 沿用旧事件台的 POST /v1/event-impacts/actions；全部只产生建议 / 预览 / 草案，不执行。
 * 「暂停后续签发」走 ConfirmDialog（只暂停签发，不撤销授权、不收回额度）。
 */
import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { toast } from "sonner";
import type { ImpactAction } from "@chaconne/core/verify";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AsyncButton } from "@/components/kit/AsyncButton";
import { ConfirmDialog } from "@/components/kit/ConfirmDialog";
import { eventDesk, type ActionResult } from "@/components/agent/events/api";
import { useI18n } from "@/lib/i18n";
import { writeErrorText } from "@/components/features/common/writeError";
import { ACTION_LABEL, copy } from "./copy";
import { enabledActions, isBlockingRule, type TaskHit } from "./impact";

export interface ActionRun { action: ImpactAction; taskId: string | null; result: ActionResult }
const TASK_ACTIONS: ImpactAction[] = ["wait_by_rule", "pause_issuance"];

export function EventActions({ owner, eventId, ev, hits, onResult }: {
  owner: string;
  eventId: string;
  ev: Parameters<typeof enabledActions>[0];
  hits: TaskHit[] | null;
  onResult: (r: ActionRun | null) => void;
}) {
  const { locale } = useI18n();
  const c = copy(locale);
  const [busy, setBusy] = useState<ImpactAction | null>(null);
  const [confirmPause, setConfirmPause] = useState<TaskHit | null>(null);
  const actions = enabledActions(ev, hits ?? []);
  const general = actions.filter((a) => a !== "preview_new_plan" && !TASK_ACTIONS.includes(a));
  const waitTargets = actions.includes("wait_by_rule") ? (hits ?? []).filter((h) => h.rules.some(isBlockingRule)) : [];
  const pauseTargets = actions.includes("pause_issuance") ? hits ?? [] : [];

  async function run(action: ImpactAction, taskId: string | null = null, extra: { wholeDayIfDayPrecision?: boolean } = {}) {
    setBusy(action);
    onResult(null);
    const r = await eventDesk.action({ owner, eventId, action, taskId, ...extra });
    setBusy(null);
    const data = r.data;
    if (data && typeof data === "object" && "effect" in data && data.effect !== "invalid" && r.status < 300) {
      onResult({ action, taskId, result: data });
      if (action !== "preview_new_plan" && action !== "view_evidence") toast.success(data.message?.[locale] ?? ACTION_LABEL[action][locale]);
      return true;
    }
    const msg = data && typeof data === "object" && "message" in data && data.message && typeof data.message === "object" ? (data.message as Record<string, string>)[locale] : null;
    toast.error(`${ACTION_LABEL[action][locale]}：${c("action_failed")}`, { description: r.error === "relay_read_only" ? c("action_blocked_local") : msg ?? writeErrorText(r, locale === "zh", c("nothing_changed")) });
    return false;
  }

  return (
    <div className="flex w-full flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <AsyncButton size="sm" pending={busy === "preview_new_plan"} pendingLabel={locale === "zh" ? "生成预览中" : "Building preview"} disabled={busy !== null && busy !== "preview_new_plan"} onClick={() => void run("preview_new_plan")}>
          {ACTION_LABEL.preview_new_plan[locale]}
        </AsyncButton>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" disabled={busy !== null}>{c("more")}<ChevronDown aria-hidden="true" /></Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-72">
            <DropdownMenuItem asChild><Link href={newTaskHref("event", { event: eventId, eventName: ev.name, asset: ev.underlyingIds.map((u) => `${u}x`) })}>{locale === "zh" ? "围绕这个事件新建任务" : "New task around this event"}</Link></DropdownMenuItem>
            {general.map((a) => <DropdownMenuItem key={a} onSelect={() => void run(a)}>{ACTION_LABEL[a][locale]}</DropdownMenuItem>)}
            {waitTargets.length ? <TaskGroup label={ACTION_LABEL.wait_by_rule[locale]} hits={waitTargets} onPick={(h) => void run("wait_by_rule", h.task.id)} /> : null}
            {pauseTargets.length ? <TaskGroup label={ACTION_LABEL.pause_issuance[locale]} hits={pauseTargets} onPick={(h) => setConfirmPause(h)} destructive /> : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <p className="text-xs text-fg-3">{c("no_exec")}</p>
      <ConfirmDialog
        open={confirmPause !== null}
        onOpenChange={(o) => { if (!o) setConfirmPause(null); }}
        title={c("pause_title")}
        consequence={<>{confirmPause ? <span className="mb-1 block truncate text-fg-1">{confirmPause.task.title}</span> : null}{c("pause_body")}</>}
        confirmLabel={c("pause_confirm")}
        pending={busy === "pause_issuance"}
        onConfirm={() => { const h = confirmPause; if (h) void run("pause_issuance", h.task.id).then((ok) => { if (ok) setConfirmPause(null); }); }}
      />
    </div>
  );
}

function TaskGroup({ label, hits, onPick, destructive = false }: { label: string; hits: TaskHit[]; onPick: (h: TaskHit) => void; destructive?: boolean }) {
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel className="text-xs font-medium text-fg-3">{label}</DropdownMenuLabel>
      {hits.map((h) => (
        <DropdownMenuItem key={h.task.id} variant={destructive ? "destructive" : "default"} onSelect={() => onPick(h)}>
          <span className="min-w-0 truncate" title={h.task.title}>{h.task.title}</span>
        </DropdownMenuItem>
      ))}
    </>
  );
}
