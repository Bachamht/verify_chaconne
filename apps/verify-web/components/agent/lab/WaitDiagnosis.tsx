"use client";
/** 等待诊断（C9 · L-01）：列**全部**阻塞项、每项证据时间、已知下次检查点（未知就写未知）、需用户处理项。取不到显示不可用。 */
import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { fmtLocal } from "@/lib/format";
import { apiError } from "@/lib/errors";
import { Card, Pill, Row } from "@/components/ui";
import { lab, type ExplainWaitView } from "./api";

const OUTCOME_TONE: Record<string, "ok" | "warn" | "info"> = { SATISFIED: "ok", UNSATISFIED: "warn", INSUFFICIENT_EVIDENCE: "info" };

export function outcomeLabel(o: string, zh: boolean): string {
  if (o === "SATISFIED") return zh ? "放行" : "Pass";
  if (o === "UNSATISFIED") return zh ? "等待" : "Wait";
  if (o === "INSUFFICIENT_EVIDENCE") return zh ? "证据不足" : "Insufficient evidence";
  return o;
}

export function WaitDiagnosis({ initialTaskId, onTaskId }: { initialTaskId: string; onTaskId?: (id: string) => void }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const [taskId, setTaskId] = useState(initialTaskId);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [d, setD] = useState<ExplainWaitView | null>(null);

  const load = useCallback(async (id: string) => {
    if (!id.trim()) return;
    setBusy(true);
    setErr(null);
    const r = await lab.explainWait(id.trim(), locale);
    setBusy(false);
    if (r.status === 200) {
      setD(r.data);
      onTaskId?.(id.trim());
    } else {
      setD(null);
      setErr(apiError(r, locale));
    }
  }, [locale, onTaskId]);
  useEffect(() => {
    if (initialTaskId) void load(initialTaskId);
  }, [initialTaskId, load]);

  const unknown = zh ? "未知" : "unknown";
  return (
    <Card title={zh ? "等待诊断 · 为什么没买？" : "Wait diagnosis · Why hasn't it bought?"} right={d ? <Pill tone={OUTCOME_TONE[d.outcome] ?? "neutral"}>{outcomeLabel(d.outcome, zh)}</Pill> : null}>
      <p className="mb-3 text-sm text-fg-2">{zh ? "列出任务的全部阻塞项——不止第一个。每项给证据时间与已知恢复点；恢复时间未知就写未知，不猜倒计时。" : "Every blocker on the task, not just the first. Each shows its evidence time and a known recovery point; unknown stays unknown, no countdown is invented."}</p>
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void load(taskId);
        }}
      >
        <input className="field flex-1 min-w-48" value={taskId} onChange={(e) => setTaskId(e.target.value)} placeholder={zh ? "任务 ID（task_…）" : "Task id (task_…)"} aria-label="task id" />
        <button className="btn" type="submit" disabled={busy || !taskId.trim()}>{busy ? "…" : zh ? "诊断" : "Explain"}</button>
      </form>
      {err && <p className="mt-3 text-sm text-warn">{zh ? "不可用：" : "Unavailable: "}{err}</p>}
      {!d && !err && !busy && <p className="mt-3 text-xs text-fg-3">{zh ? "输入一个你拥有的任务 ID。没有任务时这里显示不可用，不会伪装数据。" : "Enter a task id you own. Without a task this block stays unavailable rather than faking data."}</p>}
      {d && (
        <div className="mt-4 space-y-3">
          <div className="grid gap-x-6 md:grid-cols-2">
            <Row k={zh ? "任务状态" : "Task status"} v={<Pill tone="neutral">{d.status}</Pill>} />
            <Row k={zh ? "评估时刻" : "Evaluated at"} v={fmtLocal(d.evaluatedAt, locale)} mono />
            <Row k={zh ? "下次检查点（最早已知）" : "Next check (earliest known)"} v={d.nextCheckAt ? fmtLocal(d.nextCheckAt, locale) : unknown} mono />
            <Row k={zh ? "证据快照" : "Evidence snapshot"} v={d.evidenceSnapshotId ?? "—"} mono />
            <Row k={zh ? "求值来源" : "Evaluation source"} v={d.source === "latest_evaluation" ? (zh ? "最近一次落库评估" : "latest stored evaluation") : (zh ? `现算（${d.evaluatorId}）` : `evaluated now (${d.evaluatorId})`)} mono />
            <Row k={zh ? "执行器" : "Executor"} v={d.executorPresence} mono />
          </div>
          <p className="text-xs text-fg-3">{zh ? d.nextCheckNote.zh : d.nextCheckNote.en}</p>
          <h3 className="text-sm font-semibold">{zh ? `阻塞项（${d.blockers.length}）` : `Blockers (${d.blockers.length})`}</h3>
          {d.blockers.length === 0 ? (
            <p className="text-sm text-ok">{zh ? "没有阻塞项。" : "No blockers."}</p>
          ) : (
            <ul className="space-y-2">
              {d.blockers.map((b, i) => (
                <li key={`${b.code}-${i}`} className={`rounded-md border p-3 text-sm ${b.userActionRequired ? "border-warn/40 bg-warn/8" : "border-line bg-surface-2"}`}>
                  <div className="flex flex-wrap items-center gap-2">
                    <Pill tone={b.userActionRequired ? "warn" : "neutral"}>{b.code}</Pill>
                    {b.userActionRequired && <span className="text-xs text-warn">{zh ? "需要你处理" : "Needs your action"}</span>}
                  </div>
                  <p className="mt-1 leading-6">{zh ? (d.i18n[i]?.zh ?? b.text) : (d.i18n[i]?.en ?? b.text)}</p>
                  <div className="mono mt-1 flex flex-wrap gap-x-4 text-xs text-fg-3">
                    <span>{zh ? "证据时间" : "Evidence at"}: {b.evidenceAt ? fmtLocal(b.evidenceAt, locale) : unknown}</span>
                    <span>{zh ? "下次检查" : "Next check"}: {b.nextCheckAt ? fmtLocal(b.nextCheckAt, locale) : unknown}</span>
                    {b.evidenceIds.length > 0 && <span>{zh ? "证据" : "Evidence"}: {b.evidenceIds.join(", ")}</span>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}
