"use client";
/** /agent/tasks：owner 的任务列表（GET /v1/tasks?owner）+ 本浏览器记录；端点未部署 → 明确空态。 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { agentTasks, notReady } from "@/lib/api-v2";
import { apiError } from "@/lib/errors";
import { fmtLocal } from "@/lib/format";
import type { Task } from "@chaconne/core/verify";
import { Card, EmptyState, Pill } from "@/components/ui";
import { NotReady, OwnerField, useOwnerInput } from "../shared";

const TONE: Record<string, "ok" | "warn" | "bad" | "info" | "brand" | "neutral"> = { ACTIVE: "ok", STEP_PREPARED: "ok", COMPLETED: "ok", WAITING: "warn", PAUSED: "warn", AWAITING_AUTHORIZATION: "info", DRAFT: "neutral", PARTIAL: "info", REVOKE_PENDING: "bad", REVOKED: "bad", EXPIRED: "neutral", CANCELLED: "neutral" };

export function TasksList() {
  const { locale, t } = useI18n();
  const zh = locale === "zh";
  const { owner, setOwner, connected, valid } = useOwnerInput();
  const [state, setState] = useState<{ kind: "idle" } | { kind: "busy" } | { kind: "nr"; http: number } | { kind: "err"; msg: string } | { kind: "ok"; tasks: Task[] }>({ kind: "idle" });
  useEffect(() => {
    if (!valid) return;
    let alive = true;
    setState({ kind: "busy" });
    agentTasks.list(owner.toLowerCase()).then((r) => {
      if (!alive) return;
      if (notReady(r)) setState({ kind: "nr", http: r.status });
      else if (r.status !== 200) setState({ kind: "err", msg: apiError(r, locale) });
      else setState({ kind: "ok", tasks: r.data.tasks });
    }).catch(() => alive && setState({ kind: "nr", http: 0 }));
    return () => { alive = false; };
  }, [owner, valid, locale]);
  return (
    <>
      <header><h1 className="ag-h1">{t("nav_agent_tasks")}</h1><p className="ag-lead">{zh ? "已完成、下一步、等待原因、执行器在线情况、预算；可以暂停、撤销、进入详情。任务只对创建它的钱包可见。" : "Done, next step, why it waits, executor presence, budget; pause, revoke, open details. Tasks are visible only to the wallet that created them."}</p></header>
      <Card>
        <div className="ag-form"><OwnerField owner={owner} setOwner={setOwner} connected={connected} /></div>
        {!valid && <p className="ag-note mt-2">{zh ? "连接钱包或填地址后列出任务。" : "Connect a wallet or type an address to list tasks."}</p>}
        {state.kind === "busy" && <p className="ag-note mt-2">{t("ag_loading")}</p>}
        {state.kind === "nr" && <div className="mt-3"><NotReady what="GET /v1/tasks?owner" status={state.http} /></div>}
        {state.kind === "err" && <p className="mt-2 text-sm text-bad">{state.msg}</p>}
        {state.kind === "ok" && (state.tasks.length === 0 ? <div className="mt-3"><EmptyState compact title={zh ? "还没有任务" : "No tasks yet"} description={zh ? "从首页四个入口创建一个，模拟不需要钱包。" : "Create one from the four entries on the home page; simulation needs no wallet."} primary={{ href: "/agent?entry=buy", label: t("ag_entry_buy") }} /></div> : (
          <ul className="ag-list mt-2">
            {state.tasks.map((task) => (
              <li key={task.id}>
                <div className="ag-actions">
                  <Pill tone={TONE[task.status] ?? "neutral"}>{task.status}</Pill>
                  <Link href={`/agent/tasks/${task.id}`} className="mono text-sm underline">{task.id}</Link>
                  <span className="text-xs text-fg-2">{task.playbookId}</span>
                  <Pill tone={task.executorPresence === "online" ? "ok" : task.executorPresence === "awaiting_signature" ? "info" : "neutral"}>{task.executorPresence}</Pill>
                </div>
                <p className="ag-note">{zh ? "阻塞" : "blockers"} {task.blockers.length}{task.blockers.length ? `: ${task.blockers.map((b) => b.code).join(", ")}` : ""} · {t("ag_next_check")} {task.nextCheckAt ? fmtLocal(task.nextCheckAt, locale) : "—"} · {zh ? "授权" : "authorizations"} {task.mandateIds.length}</p>
              </li>
            ))}
          </ul>
        ))}
      </Card>
    </>
  );
}
