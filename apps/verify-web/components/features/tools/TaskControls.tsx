"use client";
/**
 * 授权任务控制：暂停 / 继续 / 取消 / 链上撤销。四种操作各自文案、各自二次确认（继续不是破坏性操作，直接执行）。
 * 一张卡 ≤ 1 主 + 1 次动作：主 = 暂停或继续，次 = 取消，链上撤销进「更多」。
 */
import { useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AsyncButton } from "@/components/kit/AsyncButton";
import { ConfirmDialog } from "@/components/kit/ConfirmDialog";
import { useI18n } from "@/lib/i18n";
import { PLANGUARD_ADDRESS } from "@/lib/planGuardAbi";
import { controlCopy, type ControlOp } from "@/components/features/common/controlCopy";
import type { TaskMandate } from "./useTaskMandate";
import { useDeepAction } from "@/lib/useDeepAction";

type Op = ControlOp;

export function TaskControls({ t }: { t: TaskMandate }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const [open, setOpen] = useState<Op | null>(null);
  const state = t.m?.state;
  const live = state === "ACTIVE" || state === "PAUSED";
  const canRevoke = (live || state === "CANCELLED") && !!PLANGUARD_ADDRESS;
  // 日志「需要你决定」带 ?do=revoke|cancel 进来：授权读到后直接打开对应确认框（仍要用户确认）
  useDeepAction((op) => {
    if (!t.m) return false;
    if (op === "revoke" && canRevoke) { setOpen("revoke"); return true; }
    if (op === "cancel" && live) { setOpen("cancel"); return true; }
    return false;
  });
  if (!t.m) return null;
  if (!live && !canRevoke) return null;

  /** 文案与控制台共用 common/controlCopy；授权任务的链上撤销成功后会同时取消任务 */
  const copy = (op: Op) => controlCopy(op, zh, { revokeAlsoCancels: true });

  async function confirm(op: Op) {
    const ok = op === "revoke" ? await t.revoke() : await t.action(op);
    if (ok) { toast.success(copy(op).done); setOpen(null); }
    else toast.error(zh ? "没有完成，原因见页面提示" : "Not completed; see the message on the page");
  }
  async function resume() {
    if (await t.action("resume")) toast.success(zh ? "任务已继续" : "Task resumed");
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {state === "ACTIVE" ? <Button size="sm" variant="outline" onClick={() => setOpen("pause")}>{zh ? "暂停" : "Pause"}</Button> : null}
      {state === "PAUSED" ? <AsyncButton size="sm" pending={t.acting === "resume"} pendingLabel={zh ? "继续中…" : "Resuming…"} onClick={() => void resume()}>{zh ? "继续" : "Resume"}</AsyncButton> : null}
      {live ? <Button size="sm" variant="ghost" onClick={() => setOpen("cancel")}>{zh ? "取消任务" : "Cancel task"}</Button> : null}
      {canRevoke ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild><Button size="icon" variant="ghost" className="size-8" aria-label={zh ? "更多操作" : "More actions"}><MoreHorizontal aria-hidden="true" /></Button></DropdownMenuTrigger>
          <DropdownMenuContent align="end"><DropdownMenuItem variant="destructive" onSelect={() => setOpen("revoke")}>{zh ? "链上撤销…" : "Revoke on-chain…"}</DropdownMenuItem></DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {open ? (
        <ConfirmDialog open onOpenChange={(o) => { if (!o) setOpen(null); }} title={copy(open).title} consequence={copy(open).body} confirmLabel={copy(open).label} tone={open === "pause" ? "default" : "danger"} pending={t.acting === open || (open === "revoke" && t.acting === "cancel")} onConfirm={() => void confirm(open)} />
      ) : null}
    </div>
  );
}
