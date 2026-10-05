"use client";
import { ListChecks } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { useResource, requestIdOf } from "@/lib/useResource";
import { apiError } from "@/lib/errors";
import { taskUiStatus } from "@/lib/status";
import { lab } from "@/components/agent/lab/api";
import { Panel } from "@/components/kit/Panel";
import { KeyValue } from "@/components/kit/KeyValue";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/kit/FourStates";
import { StatusBadge, ToneTag } from "@/components/kit/StatusBadge";
import { Timestamp } from "@/components/kit/Timestamp";
import { Hash } from "@/components/kit/Hash";
import { EXECUTOR_TEXT, outcomeMeta } from "./labText";
import { BlockerEvidenceList } from "./BlockerEvidenceList";

/** 等待诊断（GET /v1/tasks/:id/explain-wait）：全部阻塞项（不止第一个）、每项证据时间、已知下次检查；未知就写未知 */
export function DiagnoseTab({ taskId }: { taskId: string }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const r = useResource(taskId ? `ew:${taskId}:${locale}` : null, () => lab.explainWait(taskId, locale));
  const unknown = zh ? "未知" : "Unknown";

  if (!taskId) return <Panel><EmptyState art={<ListChecks className="size-8 text-fg-3" strokeWidth={1.5} aria-hidden="true" />} title={zh ? "先选一个任务" : "Pick a task first"} description={zh ? "在上方选一个你的任务，这里列出它为什么还没买的全部原因。" : "Pick one of your tasks above to see every reason it has not bought yet."} /></Panel>;
  if (r.state === "loading" || r.state === "idle") return <Panel><Panel.Body className="pt-5"><LoadingBlock rows={4} onRetry={r.reload} /></Panel.Body></Panel>;
  if (r.state === "error" || !r.data) return <Panel><ErrorState status={r.status ?? 0} requestId={requestIdOf(r.errorBody)} onRetry={r.reload} title={zh ? "诊断没有取到" : "Could not load the diagnosis"} description={r.status ? apiError({ status: r.status, data: r.errorBody }, locale) : undefined} /></Panel>;

  const d = r.data;
  const out = outcomeMeta(d.outcome, locale);
  const exec = EXECUTOR_TEXT[d.executorPresence]?.[locale] ?? unknown;
  return (
    <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
      <Panel>
        <Panel.Header
          title={zh ? `阻塞项 · ${d.blockers.length}` : `Blockers · ${d.blockers.length}`}
          description={d.blockers.length > 0 ? ((zh ? d.nextCheckNote?.zh : d.nextCheckNote?.en) ?? undefined) : undefined}
          action={<ToneTag tone={out.tone}>{out.label}</ToneTag>}
        />
        <Panel.Body>
          <BlockerEvidenceList blockers={d.blockers} i18n={d.i18n} evaluatedAt={d.evaluatedAt} fallbackEvidenceAt={d.evidenceAt ?? null} />
        </Panel.Body>
      </Panel>
      <Panel>
        <Panel.Header title={zh ? "这次评估" : "This evaluation"} level={3} />
        <Panel.Body>
          <KeyValue dense items={[
            { label: zh ? "任务状态" : "Task status", value: <StatusBadge status={taskUiStatus(d.status)} /> },
            { label: zh ? "评估时刻" : "Evaluated at", value: <Timestamp at={d.evaluatedAt} mode="both" /> },
            { label: zh ? "下次检查（最早已知）" : "Next check (earliest known)", value: d.nextCheckAt ? <Timestamp at={d.nextCheckAt} mode="both" /> : unknown },
            { label: zh ? "求值来源" : "Evaluated from", value: d.source === "latest_evaluation" ? (zh ? "最近一次存档评估" : "Latest stored evaluation") : (zh ? "现场计算" : "Computed now") },
            { label: zh ? "执行器" : "Executor", value: exec },
            { label: zh ? "证据快照" : "Evidence snapshot", value: <Hash value={d.evidenceSnapshotId} kind="id" /> },
          ]} />
        </Panel.Body>
      </Panel>
    </div>
  );
}
