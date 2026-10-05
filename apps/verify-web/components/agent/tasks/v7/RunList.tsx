"use client";
/** 轮次列表（P3）：每轮的原因、动作、决策摘要、下次检查；展开看工具调用（只给预览与哈希）。成本与哈希链折叠在细节里。 */
import { useCallback, useEffect, useState } from "react";
import type { AgentRunStep, AgentRunSummary } from "@chaconne/core/verify";
import { notReady, v7 } from "@/lib/api-v2";
import { formatTime } from "@/lib/format";
import { Card, Pill } from "@/components/ui";
import { ModeTag, NotReady } from "../../shared";
import { turnReasonLabel } from "../decisionTimelineLabels";
import { fxRuns, fxRunSteps } from "@/lib/v7fixtures";
import { useV7 } from "./useV7";

const usd = (micros: string | number | null | undefined) => {
  if (micros === null || micros === undefined || String(micros).trim() === "") return null;
  const n = Number(micros) / 1e6;
  return Number.isFinite(n) && n >= 0 ? `$${n.toFixed(n < 0.01 && n > 0 ? 4 : 2)}` : null;
};
const short = (h: string | null | undefined) => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : "—");

export function RunModelUsage({ usage }: { usage?: Partial<AgentRunSummary["usage"]> | null }) {
  const { locale } = useV7();
  const zh = locale === "zh";
  return <>
    <dt>{zh ? "模型成本" : "Model cost"}</dt>
    <dd className="text-xs">
      <span className="mono">{usd(usage?.costUsdMicros) ?? (zh ? "未提供" : "Not provided")} · {zh ? "输入" : "in"} {usage?.inputTokens ?? "—"} / {zh ? "输出" : "out"} {usage?.outputTokens ?? "—"}</span>
      <span className="ag-note block">{zh ? "本轮模型使用成本记录，非用户账单。" : "Model usage recorded for this round, not a user bill."}</span>
    </dd>
  </>;
}

export function RunList({ taskId, fixture = false, mode, refreshKey }: { taskId: string; fixture?: boolean; mode: "LIVE" | "SIMULATION"; refreshKey?: unknown }) {
  const { s } = useV7();
  const [runs, setRuns] = useState<AgentRunSummary[] | null>(fixture ? fxRuns(mode) : null);
  const [nr, setNr] = useState<number | null>(null);
  const load = useCallback(async () => {
    if (fixture) return;
    const r = await v7.runs(taskId).catch(() => null);
    if (!r || r.status === 0) return;
    if (notReady(r)) { setNr(r.status); return; }
    if (r.status === 200) { setRuns(r.data.runs); setNr(null); }
  }, [fixture, taskId]);
  useEffect(() => { void load(); }, [load, refreshKey]);
  return (
    <Card title={`${s("run_h")}${runs ? ` · ${runs.length}` : ""}`}>
      {nr !== null ? <NotReady what="GET /v1/tasks/:id/runs" status={nr} onRetry={() => void load()} /> : !runs ? <p className="ag-note">{s("loading")}</p> : runs.length === 0 ? <p className="ag-note">{s("run_empty")}</p> : (
        <div>
          {[...runs].sort((a, b) => b.turnVersion - a.turnVersion).map((r) => <RunRow key={r.runId} r={r} taskId={taskId} fixture={fixture} />)}
        </div>
      )}
      <p className="ag-note mt-2">{s("proof_scope")}</p>
    </Card>
  );
}

function RunRow({ r, taskId: tid, fixture: fx }: { r: AgentRunSummary; taskId: string; fixture: boolean }) {
    const { s, m, locale } = useV7();
    const [steps, setSteps] = useState<AgentRunStep[] | null | "err">(null);
    const open = async () => {
      if (steps !== null) return;
      if (fx) { setSteps(fxRunSteps(r.runId)); return; }
      const d = await v7.run(tid, r.runId).catch(() => null);
      setSteps(d && d.status === 200 ? d.data.steps : "err");
    };
    const stateTone = r.state === "COMPLETED" ? "ok" : r.state === "RUNNING" || r.state === "CLAIMED" ? "info" : r.state === "FAILED" ? "bad" : "neutral";
    return (
      <details className="v7-run" onToggle={(e) => { if ((e.currentTarget as HTMLDetailsElement).open) void open(); }}>
        <summary>
          <span className="mono text-xs text-fg-3">#{r.turnVersion}</span>
          <span>{m(`reason_${r.turnReason}`) ?? turnReasonLabel(r.turnReason as never, locale)}</span>
          <Pill tone={stateTone}>{m(`run_state_${r.state}`) ?? r.state}</Pill>
          {r.mode === "SIMULATION" && <ModeTag mode="SIMULATION" />}
          <span className="ag-note">{formatTime(r.startedAt, locale)}</span>
        </summary>
        <p>{r.decisionSummary || "—"}</p>
        <dl className="ag-kv mt-2">
          <dt>{s("run_action")}</dt><dd>{r.action ? `${r.action.kind} · ${r.action.status}` : s("run_no_action")}</dd>
          {r.nextCheckAt && <><dt>{s("run_next")}</dt><dd>{formatTime(r.nextCheckAt, locale)}</dd></>}
          {r.invalidation && <><dt>{s("run_invalidation")}</dt><dd>{r.invalidation}</dd></>}
          <dt>{s("run_tools", { n: r.toolCalls.length })}</dt><dd>{r.toolCalls.map((t) => t.name).join(" · ") || "—"}</dd>
          <dt>{s("run_model")}</dt><dd className="mono text-xs">{r.model}</dd>
          <RunModelUsage usage={r.usage} />
          <dt>{s("run_hash")}</dt><dd className="v7-hash">{short(r.runHash)} ← {short(r.prevRunHash)}</dd>
        </dl>
        {steps === "err" ? <p className="ag-note mt-2">{s("run_steps_unavailable")}</p> : steps && (
          <ol className="v7-steps">
            {steps.map((st) => (
              <li key={st.seq}>
                <span className="mono">{st.seq}. {st.kind === "tool" ? st.name : "model"}</span> · <span className="text-fg-3">{st.latencyMs} ms</span>
                {st.argsPreview && <div><code>{st.argsPreview}</code></div>}
                {st.resultPreview && <div><code>→ {st.resultPreview}</code></div>}
                {st.kind === "model" && <div><code>tokens {st.tokensIn ?? 0} / {st.tokensOut ?? 0}</code></div>}
                {st.error && <div className="text-bad">{st.error}</div>}
              </li>
            ))}
          </ol>
        )}
      </details>
    );
}
