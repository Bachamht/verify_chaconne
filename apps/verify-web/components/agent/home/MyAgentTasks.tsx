"use client";
/** 首页「运行中的任务」：这个钱包名下的任务，目标式任务显示目标、接管的 agent 与轮次状态；未连钱包只提示 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { agentTasks } from "@/lib/api-v2";
import type { Task } from "@chaconne/core/verify";
import { Card, Pill } from "@/components/ui";
import { statusLabel, taskTitle } from "../tasks/taskTitle";

export function MyAgentTasks({ account }: { account: string | null }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const [tasks, setTasks] = useState<Task[] | null>(null);
  useEffect(() => {
    if (!account) { setTasks(null); return; }
    let alive = true;
    agentTasks.list(account.toLowerCase()).then((r) => { if (alive) setTasks(r.status === 200 ? r.data.tasks : []); }).catch(() => alive && setTasks([]));
    return () => { alive = false; };
  }, [account]);
  if (!account) return null;
  const live = (tasks ?? []).filter((t) => !["COMPLETED", "CANCELLED", "REVOKED", "EXPIRED"].includes(t.status)).slice(0, 8);
  return (
    <Card title={zh ? "我的 Agent 任务" : "My agent tasks"} right={<Link className="text-sm underline" href="/agent/tasks">{zh ? "全部任务 →" : "All tasks →"}</Link>}>
      {tasks === null ? <p className="ag-note">…</p> : live.length === 0 ? <p className="ag-note">{zh ? "还没有运行中的任务。上面写一个目标交给 Agent。" : "No running task yet. Hand a goal to your agent above."}</p> : (
        <ul className="divide-y divide-line text-sm">
          {live.map((t) => {
            const agent = t.brief?.agent;
            return (
              <li key={t.id} className="flex flex-wrap items-center gap-3 py-2">
                <Link href={`/agent/tasks/${t.id}`} className="min-w-0 flex-1 truncate underline underline-offset-2">{taskTitle(t, undefined, [], locale)}</Link>
                <Pill tone="neutral">{statusLabel(t.status, locale)}</Pill>
                {t.scope?.issuance === "agent" && <Pill tone={agent ? "ok" : "warn"}>{agent ? `${agent.name}` : (zh ? "等待 Agent 接管" : "waiting for an agent")}</Pill>}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}
