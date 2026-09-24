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
import { LoadingState, NotReady, OwnerField, Skeleton, useOwnerInput } from "../shared";
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
      <header><h1 className="ag-h1">{t("ag_tasks_h")}</h1><p className="ag-lead">{zh ? "已完成、下一步、等待原因、执行器在线情况、预算；可以暂停、撤销、进入详情。任务只对创建它的钱包可见。" : "Done, next step, why it waits, executor presence, budget; pause, revoke, open details. Tasks are visible only to the wallet that created them."}</p></header>
      <Card>
        <div className="ag-form"><OwnerField owner={owner} setOwner={setOwner} connected={connected} /></div>
        {!valid && <p className="ag-note mt-2">{zh ? "连接钱包或填地址后列出任务。" : "Connect a wallet or type an address to list tasks."}</p>}
        {state.kind === "busy" && <div className="mt-3 space-y-2" aria-busy="true"><LoadingState onRetry={reload} /><Skeleton lines={3} /></div>}
        {state.kind === "nr" && <div className="mt-3"><NotReady what="GET /v1/tasks?owner" status={state.http} onRetry={reload} /></div>}
        {state.kind === "err" && <p className="mt-2 text-sm text-bad">{state.msg}</p>}
        {state.kind === "ok" && (state.tasks.length === 0 ? <div className="mt-3"><EmptyState compact title={zh ? "还没有任务" : "No tasks yet"} description={zh ? "从首页四个入口创建一个，模拟不需要钱包。" : "Create one from the four entries on the home page; simulation needs no wallet."} primary={{ href: "/agent?entry=buy", label: t("ag_entry_buy") }} /></div> : (
          <ul className="ag-list mt-2">
            {state.tasks.map((task) => (
              <li key={task.id} className="ag-task-row">
                <div className="ag-actions">
                  <h3><Link href={`/agent/tasks/${task.id}`} className="underline-offset-2 hover:underline">{taskTitle(task, null, assets, locale)}</Link></h3>
                  <Pill tone={TONE[task.status] ?? "neutral"}>{statusLabel(task.status, locale)}</Pill>
                  {task.mandateIds.length > 0 && <Pill tone="info">{zh ? `授权 ${task.mandateIds.length}` : `${task.mandateIds.length} authorization(s)`}</Pill>}
                </div>
                <p className="ag-note">{nextLine(task)}</p>
                <p className="ag-note">{zh ? "创建" : "created"} {formatTime(task.createdAt, locale)} · <Link className="underline" href={`/agent/tasks/${task.id}`}>{zh ? "详情" : "details"}</Link> · <Link className="underline" href={`/agent/lab?taskId=${task.id}#wait`}>{t("ag_entry_wait")}</Link></p>
              </li>
            ))}
          </ul>
        ))}
      </Card>
    </>
  );
}
