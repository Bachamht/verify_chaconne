"use client";
import Link from "next/link";
import { useMemo, useState } from "react";
import { ArrowRight, MoreHorizontal } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { DetailSheet } from "@/components/kit/DetailSheet";
import { ConfirmDialog } from "@/components/kit/ConfirmDialog";
import { StatusBadge } from "@/components/kit/StatusBadge";
import { ErrorState, LoadingBlock } from "@/components/kit/FourStates";
import { agentTasks, taskV7Extras } from "@/lib/api-v2";
import { apiError } from "@/lib/errors";
import { useI18n } from "@/lib/i18n";
import { modeUiStatus } from "@/lib/status";
import { requestIdOf, useResource } from "@/lib/useResource";
import { deleteConsequence, mergeTaskRows, type TaskRow } from "./model";
import type { TaskBoard } from "./loadBoard";
import { TaskSheetBody } from "./TaskSheetBody";

/**
 * 列表 → 详情抽屉（URL ?id=）：概要 + 阻塞项 +「打开控制台」主按钮；删除在「更多」里并二次确认。
 * 详情单独取一次（GET /v1/tasks/:id），所以直接打开 ?id= 链接、或任务不在当前筛选里也能显示。
 */
export function TaskSheet({ id, owner, board, row, onClose, onDeleted }: {
  id: string;
  owner: string;
  board: TaskBoard | null;
  row: TaskRow | null;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const { locale, t } = useI18n();
  const zh = locale === "zh";
  const detail = useResource(id ? `task:${owner}:${id}` : null, () => agentTasks.get(id, owner.toLowerCase()));
  const [confirm, setConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const view = useMemo<TaskRow | null>(() => {
    const d = detail.data;
    if (!d?.task) return row;
    const merged = mergeTaskRows({ listed: [d.task], details: {}, records: board?.records ?? null, assets: board?.assets ?? [], locale })[0] ?? null;
    if (merged && !merged.mode && d.mode) merged.mode = d.mode === "LIVE" || d.mode === "SIMULATION" ? d.mode : null;
    return merged ? { ...merged, mode: merged.mode ?? row?.mode ?? null, spentRaw: row?.spentRaw ?? merged.spentRaw, title: row?.title ?? merged.title } : row;
  }, [detail.data, row, board, locale]);
  const runtime = detail.data ? taskV7Extras(detail.data).runtime : null;

  async function remove() {
    setDeleting(true);
    const r = await agentTasks.archive(id).catch(() => null);
    setDeleting(false);
    if (!r || r.status !== 200) {
      toast.error(r ? apiError(r, locale) : t("ag_service_unreachable"));
      return;
    }
    setConfirm(false);
    toast.success(r.data.cancelled ? (zh ? "已取消并从列表移除" : "Cancelled and removed from your lists") : (zh ? "已从列表移除" : "Removed from your lists"));
    onDeleted();
  }

  const mode = modeUiStatus(view?.mode);
  return (
    <>
      <DetailSheet
        open={Boolean(id)}
        onOpenChange={(o) => { if (!o) onClose(); }}
        title={view?.title ?? (zh ? "任务" : "Task")}
        badges={view ? <><StatusBadge status={view.status} />{mode ? <StatusBadge status={mode} /> : null}</> : null}
        footer={
          <>
            <Button asChild><Link href={`/agent/tasks/${id}`}>{zh ? "打开控制台" : "Open console"}<ArrowRight aria-hidden="true" /></Link></Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button variant="outline" size="icon" aria-label={zh ? "更多操作" : "More actions"}><MoreHorizontal aria-hidden="true" /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem variant="destructive" onSelect={() => setConfirm(true)}>{zh ? "删除任务…" : "Delete task…"}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      >
        {detail.state === "loading" && !view ? <LoadingBlock rows={6} /> : null}
        {detail.state === "error" && !view ? <ErrorState size="sm" status={detail.status ?? undefined} requestId={requestIdOf(detail.errorBody)} onRetry={detail.reload} /> : null}
        {view ? <TaskSheetBody row={view} task={detail.data?.task ?? view.task} steps={detail.data?.steps ?? null} needs={runtime?.needsOwner ?? null} loading={detail.state === "loading"} /> : null}
      </DetailSheet>
      <ConfirmDialog
        open={confirm}
        onOpenChange={setConfirm}
        title={zh ? "删除这个任务？" : "Delete this task?"}
        consequence={deleteConsequence(view?.rawStatus ?? "ACTIVE", locale)}
        confirmLabel={zh ? "删除任务" : "Delete task"}
        pending={deleting}
        onConfirm={() => void remove()}
      />
    </>
  );
}
