"use client";
/** /agent/tasks：owner 的任务列表（GET /v1/tasks?owner）。V-32：卡片式行——标题 = 模板 · 资产 · 金额，状态胶囊，下一步一句话；不露 tsk_ id 与原始码。 */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { agentTasks, notReady } from "@/lib/api-v2";
import { apiError } from "@/lib/errors";
import { formatTime } from "@/lib/format";
import { loadAssets, type AssetEntry } from "@/lib/assets";
import type { Task } from "@chaconne/core/verify";
import { Card, EmptyState, Pill } from "@/components/ui";
import { LoadingState, NotReady, OwnerField, Skeleton, useOwnerInput, useToast, Toast } from "../shared";
import { RecordsList } from "@/components/MyTasks";
import { blockerSentence, statusLabel, taskTitle } from "./taskTitle";

const TONE: Record<string, "ok" | "warn" | "bad" | "info" | "brand" | "neutral"> = { ACTIVE: "ok", STEP_PREPARED: "ok", COMPLETED: "ok", WAITING: "warn", PAUSED: "warn", AWAITING_AUTHORIZATION: "info", DRAFT: "neutral", PARTIAL: "info", REVOKE_PENDING: "bad", REVOKED: "bad", EXPIRED: "neutral", CANCELLED: "neutral" };

export function TasksList() {
  const { locale, t } = useI18n();
  const zh = locale === "zh";
  const { owner, setOwner, connected, valid } = useOwnerInput();
  const [assets, setAssets] = useState<AssetEntry[]>([]);
  const [state, setState] = useState<{ kind: "idle" } | { kind: "busy" } | { kind: "nr"; http: number } | { kind: "err"; msg: string } | { kind: "ok"; tasks: Task[] }>({ kind: "idle" });
  const [seq, setSeq] = useState(0);
  const reload = useCallback(() => setSeq((n) => n + 1), []);
  const [toast, setToast] = useToast();
  const [deleting, setDeleting] = useState<string | null>(null);
  async function remove(task: Task) {
    const running = !["COMPLETED", "CANCELLED", "REVOKED", "EXPIRED"].includes(task.status);
    if (!window.confirm(running ? (zh ? "这个任务还在运行：删除会先取消它（服务侧停止签发；已取走的证书到期前仍可能执行），然后从列表移除。继续？" : "This task is still running: deleting cancels it first (issuance stops; pulled certificates may execute until they expire), then removes it from your lists. Continue?") : (zh ? "从列表移除这个任务？记录与证据保留，详情仍可打开。" : "Remove this task from your lists? Records and evidence are kept; the detail page stays open."))) return;
    setDeleting(task.id);
    const r = await agentTasks.archive(task.id).catch(() => null);
    setDeleting(null);
    if (!r || r.status !== 200) return setToast({ text: r ? apiError(r, locale) : t("ag_service_unreachable"), tone: "bad" });
    setToast({ text: zh ? "已删除。" : "Deleted.", tone: "ok" });
    reload();
  }
  useEffect(() => { void loadAssets().then((r) => setAssets(r.assets)); }, []);
  useEffect(() => {
    if (!valid) return;
    let alive = true;
    setState({ kind: "busy" });
    agentTasks.list(owner.toLowerCase()).then((r) => {
      if (!alive) return;
      if (r.status === 0 || notReady(r)) setState({ kind: "nr", http: r.status });
      else if (r.status !== 200) setState({ kind: "err", msg: apiError(r, locale) });
      else setState({ kind: "ok", tasks: r.data.tasks });
    }).catch(() => alive && setState({ kind: "nr", http: 0 }));
    return () => { alive = false; };
  }, [owner, valid, locale, seq]);
  const nextLine = (task: Task): string => {
    if (task.status === "PAUSED") return zh ? "已暂停，点进去可继续或取消。" : "Paused; open to resume or cancel.";
    if (task.status === "AWAITING_AUTHORIZATION") return zh ? "等你签一次授权后才会开始。" : "Starts after you sign the authorization once.";
    if (task.blockers.length === 0) return zh ? "没有阻塞项。" : "No blockers.";
    const first = blockerSentence(task.blockers[0]!, locale);
    const more = task.blockers.length > 1 ? (zh ? `（还有 ${task.blockers.length - 1} 项）` : ` (+${task.blockers.length - 1} more)`) : "";
    const next = task.nextCheckAt ? ` · ${t("ag_next_check")} ${formatTime(task.nextCheckAt, locale)}` : "";
    return `${first}${more}${next}`;
  };
  return (
    <>
      <header><h1 className="ag-h1">{t("ag_tasks_h")}</h1><p className="ag-lead">{zh ? "这个钱包名下的计划、等待原因和下一步。" : "Plans, waiting reasons and next steps under this wallet."}</p></header>
      <Card title={zh ? "我的任务" : "My tasks"}>
        <div className="ag-form"><OwnerField owner={owner} setOwner={setOwner} connected={connected} /></div>
        
        {state.kind === "busy" && <div className="mt-3 space-y-2" aria-busy="true"><LoadingState onRetry={reload} /><Skeleton lines={3} /></div>}
        {state.kind === "nr" && <div className="mt-3"><NotReady what="GET /v1/tasks?owner" status={state.http} onRetry={reload} /></div>}
        {state.kind === "err" && <p className="mt-2 text-sm text-bad">{state.msg}</p>}
        {state.kind === "ok" && (state.tasks.length === 0 ? <div className="mt-3"><EmptyState compact title={zh ? "还没有任务" : "No tasks yet"} description={zh ? "写一个目标交给 Agent，或者先用示例任务走一轮。" : "Hand a goal to your agent, or try an example round first."} primary={{ href: "/agent", label: zh ? "把目标交给 Agent" : "Hand a goal to your agent" }} secondary={{ href: "/start", label: zh ? "先走一轮示例" : "Try an example round" }} /></div> : (
          <ul className="ag-list mt-2">
            {state.tasks.map((task) => (
              <li key={task.id} className="ag-task-row">
                <div className="ag-actions">
                  <h3><Link href={`/agent/tasks/${task.id}`} className="underline-offset-2 hover:underline">{taskTitle(task, null, assets, locale)}</Link></h3>
                  <Pill tone={TONE[task.status] ?? "neutral"}>{statusLabel(task.status, locale)}</Pill>
                  {task.mandateIds.length > 0 && <Pill tone="info">{zh ? `授权 ${task.mandateIds.length}` : `${task.mandateIds.length} authorization(s)`}</Pill>}
                </div>
                <p className="ag-note">{nextLine(task)}</p>
                <p className="ag-note">{zh ? "创建" : "created"} {formatTime(task.createdAt, locale)} · <Link className="underline" href={`/agent/tasks/${task.id}`}>{zh ? "详情" : "details"}</Link> · <button type="button" className="underline text-bad" disabled={deleting === task.id} onClick={() => void remove(task)}>{deleting === task.id ? "…" : (zh ? "删除" : "delete")}</button></p>
              </li>
            ))}
          </ul>
        ))}
        <p className="ag-note mt-3"><Link className="underline" href="/agent">{zh ? "把目标交给 Agent →" : "Hand a goal to your agent →"}</Link></p>
      </Card>
      {valid && (
        <Card title={zh ? "全部记录" : "All records"}>
          <p className="ag-note mb-2">{zh ? "这个钱包名下的任务、授权、规划、单笔核验与模拟，按时间倒序。" : "Tasks, authorizations, plans, single verifications and simulations under this wallet, newest first."}</p>
          <RecordsList account={owner} />
        </Card>
      )}
      <Toast msg={toast} onClose={() => setToast(null)} />
    </>
  );
}
