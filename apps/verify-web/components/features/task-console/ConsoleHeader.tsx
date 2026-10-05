"use client";
/**
 * 控制台页头：人类标题 + 状态徽章 ×2 + 控制按钮组（主动作 ≤1：完成委托 / 继续；次动作：暂停；其余进「更多」）。
 * 暂停 / 取消 / 收回额度 / 链上撤销 / 删除各有自己的确认文案（产品语义：四种「停」不是一回事）。
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { toast } from "sonner";
import type { TradeMandate } from "@chaconne/core/verify";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AsyncButton } from "@/components/kit/AsyncButton";
import { ConfirmDialog } from "@/components/kit/ConfirmDialog";
import { PageHeader } from "@/components/kit/PageHeader";
import { StatusBadge } from "@/components/kit/StatusBadge";
import { Timestamp } from "@/components/kit/Timestamp";
import { useI18n } from "@/lib/i18n";
import { v7 } from "@/lib/api-v2";
import { apiError } from "@/lib/errors";
import { controlCopy } from "@/components/features/common/controlCopy";
import { useDeepAction, type DeepAction } from "@/lib/useDeepAction";
import type { UiStatus } from "@/lib/status";
import type { PrimaryAction } from "./consoleModel";
import type { useTaskControls } from "./useTaskControls";

type Confirm = "pause" | "cancel" | "delete" | "revoke" | "decide" | null;

export function ConsoleHeader({ id, title, status, mode, updatedAt, primary, stoppable, paused, sim, fixture, controls, revokeMandate, onDelegate, hostedExecutor, request }: {
  id: string;
  title: string;
  status: UiStatus;
  mode: UiStatus | null;
  updatedAt: string | null;
  primary: PrimaryAction;
  stoppable: boolean;
  paused: boolean;
  sim: boolean;
  fixture: boolean;
  controls: ReturnType<typeof useTaskControls>;
  revokeMandate: TradeMandate | null;
  onDelegate: () => void;
  hostedExecutor: boolean;
  /** 页内「需要我处理什么」点了某项：打开对应确认框（n 用来区分连点两次） */
  request?: { op: DeepAction; n: number } | null;
}) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const [confirm, setConfirm] = useState<Confirm>(null);
  const busy = controls.pending !== null || fixture;
  const running = stoppable || paused;
  // 「今天」、日志「需要你决定」带 ?do=… 进来，或页内待办点了：数据到了就直接打开对应确认框 / 面板（仍要用户确认）
  function openOp(op: DeepAction): boolean {
    if (fixture) return false;
    if (op === "revoke" && !sim && revokeMandate && controls.canRevoke) { setConfirm("revoke"); return true; }
    if (op === "cancel" && running) { setConfirm("cancel"); return true; }
    if (op === "decide" && paused) { setConfirm("decide"); return true; }
    if (op === "decide" && running) { setConfirm("cancel"); return true; }
    if (op === "delegate" && primary === "delegate") { onDelegate(); return true; }
    return false;
  }
  useDeepAction(openOp);
  useEffect(() => {
    if (request && !openOp(request.op)) toast.info(zh ? "现在不需要做这一步了。" : "This step is no longer needed.");
    // 只在新请求到来时响应（依赖只放 n）
  }, [request?.n]);

  async function share() {
    if (fixture) { toast.info(zh ? "示例数据不生成公开看板" : "Fixtures do not create a public board"); return; }
    const r = await v7.shareActivity(id).catch(() => null);
    if (!r || r.status === 0) return void toast.error(zh ? "服务暂时连不上，稍后再试" : "Service unreachable; try again shortly");
    if (r.status !== 200 && r.status !== 201) return void toast.error(apiError(r, locale));
    const url = `${window.location.origin}/live/agent/${r.data.shareId}`;
    await navigator.clipboard.writeText(url).catch(() => undefined);
    toast.success(zh ? "公开看板链接已复制（只显示类别与时间）" : "Public board link copied (categories and times only)", { description: url });
  }

  const COPY: Record<Exclude<Confirm, null>, { title: string; body: string; label: string; run: () => Promise<boolean> }> = {
    pause: { ...controlCopy("pause", zh, { hostedExecutor }), run: controls.pause },
    cancel: { ...controlCopy("cancel", zh), run: controls.cancel },
    delete: { title: zh ? "从列表删除这个任务？" : "Remove this task from your lists?", body: running ? (zh ? "这个任务还在运行：删除会先取消它（服务侧停止签发；已取走的证书到期前仍可能执行），然后从列表移除。记录与证据保留。" : "This task is still running: deleting cancels it first (issuance stops; certificates already taken may execute until they expire), then removes it from your lists. Records and evidence are kept.") : (zh ? "记录与证据保留，这一页仍可打开。" : "Records and evidence are kept; this page stays reachable."), label: zh ? "删除任务" : "Remove task", run: controls.remove },
    revoke: { ...controlCopy("revoke", zh), run: async () => (revokeMandate ? controls.revoke(revokeMandate) : false) },
    decide: { title: zh ? "继续运行，还是取消？" : "Resume or cancel?", body: zh ? "继续后 Agent 按原来的范围接着判断。取消后不能再继续，链上额度不会自动收回。" : "Resuming lets the agent carry on within the same scope. Cancelling cannot be undone, and on-chain allowances are not reclaimed automatically.", label: zh ? "继续运行" : "Resume", run: controls.resume },
  };
  const c = confirm ? COPY[confirm] : null;

  return (
    <>
      <PageHeader
        className="ch-console-header"
        breadcrumb={<Link href="/agent/tasks" className="hover:text-fg-1">{zh ? "任务" : "Tasks"}</Link>}
        title={title}
        badges={<><StatusBadge status={status} />{mode ? <StatusBadge status={mode} /> : null}</>}
        description={updatedAt ? <>{zh ? "更新于 " : "Updated "}<Timestamp at={updatedAt} mode="rel" /></> : undefined}
        actions={<>
          {primary === "delegate" ? <Button onClick={onDelegate}>{zh ? "完成委托签名" : "Finish delegation"}</Button> : null}
          {primary === "resume" ? <AsyncButton pending={controls.pending === "resume"} pendingLabel={zh ? "恢复中…" : "Resuming…"} disabled={busy} onClick={() => void controls.resume()}>{zh ? "继续运行" : "Resume"}</AsyncButton> : null}
          {stoppable ? <Button variant="outline" disabled={busy} onClick={() => setConfirm("pause")}>{zh ? "暂停" : "Pause"}</Button> : null}
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button variant="outline" size="icon" aria-label={zh ? "更多操作" : "More actions"}><MoreHorizontal aria-hidden="true" /></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              {running ? <DropdownMenuItem disabled={busy} onSelect={() => setConfirm("cancel")}>{zh ? "取消任务…" : "Cancel task…"}</DropdownMenuItem> : null}
              {!sim ? <DropdownMenuItem asChild><Link href="/agent/funds#allowances">{zh ? "收回额度（资金页）" : "Reclaim allowance (Funds)"}</Link></DropdownMenuItem> : null}
              {!sim && revokeMandate && controls.canRevoke ? <DropdownMenuItem disabled={busy} onSelect={() => setConfirm("revoke")}>{zh ? "链上撤销授权…" : "Revoke authorization on-chain…"}</DropdownMenuItem> : null}
              <DropdownMenuItem onSelect={() => void share()}>{zh ? "生成公开值守看板" : "Create a public watch board"}</DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" disabled={busy} onSelect={() => setConfirm("delete")}>{zh ? "删除任务…" : "Remove task…"}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </>}
      />
      {c ? <ConfirmDialog open onOpenChange={(o) => { if (!o) setConfirm(null); }} title={c.title} consequence={c.body} confirmLabel={c.label} tone={confirm === "pause" || confirm === "decide" ? "default" : "danger"} pending={controls.pending !== null} onConfirm={() => void c.run().then(() => setConfirm(null))}>
        {confirm === "decide" ? <Button variant="ghost" size="sm" className="self-start" disabled={controls.pending !== null} onClick={() => setConfirm("cancel")}>{zh ? "改为取消任务…" : "Cancel the task instead…"}</Button> : null}
      </ConfirmDialog> : null}
    </>
  );
}
