"use client";
/**
 * /agent/tasks（v8，方案 §5.5）：一眼看出每个任务的状态、下一步、花了多少。
 * 工具条（状态 / 模式 / 搜索，全部进 URL）+ DataTable（手机变卡片）+ 右侧抽屉（?id=）。
 * 数据：/v1/tasks 与 /v1/records 合并（Agent 接入 key 建的任务也在这里）。
 */
import Link from "next/link";
import { useCallback, useDeferredValue, useMemo } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { PageHeader } from "@/components/kit/PageHeader";
import { Panel } from "@/components/kit/Panel";
import { DataTable } from "@/components/kit/DataTable";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/kit/FourStates";
import { Mascot } from "@/components/kit/Mascot";
import { useI18n } from "@/lib/i18n";
import { useAccount } from "@/lib/useAccount";
import { useQueryState } from "@/lib/useQueryState";
import { requestIdOf, useResource } from "@/lib/useResource";
import { loadTaskBoard } from "./loadBoard";
import { filterRows, groupCounts, mergeTaskRows, parseGroup, parseMode } from "./model";
import { TaskCard, taskColumns } from "./taskColumns";
import { TaskSheet } from "./TaskSheet";
import { TasksToolbar } from "./TasksToolbar";

export function TasksPage() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const account = useAccount();
  const board = useResource(account ? `tasks:${account.toLowerCase()}` : null, () => loadTaskBoard(account!), { intervalMs: 30_000 });
  const [groupQ, setGroup] = useQueryState("status");
  const [modeQ, setMode] = useQueryState("mode");
  const [q, setQ] = useQueryState("q");
  const [id, setId] = useQueryState("id");
  const deferredQ = useDeferredValue(q);

  const rows = useMemo(() => (board.data ? mergeTaskRows({ ...board.data, locale }) : []), [board.data, locale]);
  const filter = { group: parseGroup(groupQ), mode: parseMode(modeQ), q };
  const shown = useMemo(() => filterRows(rows, { group: parseGroup(groupQ), mode: parseMode(modeQ), q: deferredQ }), [rows, groupQ, modeQ, deferredQ]);
  const counts = useMemo(() => groupCounts(rows), [rows]);
  const columns = useMemo(() => taskColumns(locale), [locale]);
  const onQuery = useCallback((v: string) => setQ(v), [setQ]);
  const clear = () => { setGroup(null); setMode(null); setQ(null); };
  const newTask = <Button asChild><Link href="/agent/new"><Plus aria-hidden="true" />{zh ? "新建任务" : "New task"}</Link></Button>;

  return (
    <>
      <PageHeader
        title={zh ? "任务" : "Tasks"}
        description={zh ? "这个钱包名下的全部任务：状态、下一步和花了多少。浏览器和 Agent 接入 key 建的都在这里。" : "Every task under this wallet: status, next step and spend. Tasks created in the browser and with an Agent API key are both here."}
        actions={rows.length > 0 ? newTask : null}
      />
      {board.state === "loading" || board.state === "idle" ? (
        <Panel><Panel.Body className="pt-4"><LoadingBlock rows={8} onRetry={board.reload} /></Panel.Body></Panel>
      ) : board.state === "error" ? (
        <Panel><ErrorState status={board.status ?? undefined} requestId={requestIdOf(board.errorBody)} onRetry={board.reload} title={zh ? "任务列表没有拿到" : "Could not load your tasks"} /></Panel>
      ) : rows.length === 0 ? (
        <Panel>
          <EmptyState
            art={<Mascot alt={zh ? "Chaconne 小指挥家" : "Chaconne's conductor"} />}
            title={zh ? "这个钱包还没有任务" : "No tasks under this wallet yet"}
            description={zh ? "先建一个观察任务：Agent 只判断、不交易，看过再决定要不要真实运行。" : "Start with an observation task: the agent only evaluates and never trades, then decide whether to go live."}
            action={newTask}
          />
        </Panel>
      ) : (
        <>
          <TasksToolbar filter={filter} counts={counts} onGroup={(g) => setGroup(g === "all" ? null : g)} onMode={(m) => setMode(m === "all" ? null : m)} onQuery={onQuery} />
          {board.data?.partial ? (
            <Alert className="mb-4 border-warn/35 bg-surface-warn">
              <AlertDescription className="text-sm text-fg-2">
                {board.data.partial === "records"
                  ? (zh ? "全部记录这次没有返回，用 Agent 接入 key 建的任务和已用预算可能缺失。稍后会自动重试。" : "Records did not load this time, so tasks created with an Agent API key and budget used may be missing. Retrying automatically.")
                  : (zh ? "任务列表这次没有返回，下面只有记录里的任务，阻塞项可能不全。稍后会自动重试。" : "The task list did not load this time; only tasks from your records are shown and blockers may be incomplete. Retrying automatically.")}
              </AlertDescription>
            </Alert>
          ) : null}
          <Panel>
            <Panel.Body flush className="sm:px-2 sm:pb-2">
              <DataTable
                columns={columns}
                data={shown}
                getRowId={(r) => r.id}
                onRowClick={(r) => setId(r.id)}
                density="comfortable"
                caption={zh ? "任务列表" : "Tasks"}
                cardRow={(r) => <TaskCard row={r} locale={locale} onOpen={setId} />}
                className="p-3 sm:p-0"
                empty={<EmptyState size="sm" title={zh ? "没有符合筛选的任务" : "No tasks match these filters"} description={zh ? `共 ${rows.length} 个任务，被当前筛选隐藏了。` : `${rows.length} tasks are hidden by the current filters.`} action={<Button variant="outline" size="sm" onClick={clear}>{zh ? "清除筛选" : "Clear filters"}</Button>} />}
              />
            </Panel.Body>
          </Panel>
        </>
      )}
      {account && id ? (
        <TaskSheet id={id} owner={account} board={board.data} row={rows.find((r) => r.id === id) ?? null} onClose={() => setId(null)} onDeleted={() => { setId(null); board.reload(); }} />
      ) : null}
    </>
  );
}
