"use client";
/** 接管切换（P3）：托管 / 自带 Agent；平台执行 / Agent 钱包 / 浏览器。不改范围、不需签名；有交易在发送时服务端回 409。 */
import { useEffect, useState } from "react";
import type { AgentMode, ExecutorMode, TaskRuntime } from "@chaconne/core/verify";
import { v7 } from "@/lib/api-v2";
import { apiError } from "@/lib/errors";
import { Card } from "@/components/ui";
import { useV7 } from "./useV7";

export function HandoverCard({ taskId, runtime, sim, fixture, disabled, onChanged }: { taskId: string; runtime: TaskRuntime | null; sim: boolean; fixture: boolean; disabled?: boolean; onChanged: (msg: { text: string; tone: "ok" | "bad" | "warn" }) => void }) {
  const { s, m, locale } = useV7();
  const [agent, setAgent] = useState<AgentMode | "none">(runtime?.agentMode ?? "none");
  const [executor, setExecutor] = useState<ExecutorMode>(runtime?.executorMode ?? "hosted");
  const [busy, setBusy] = useState(false);
  useEffect(() => { setAgent(runtime?.agentMode ?? "none"); setExecutor(runtime?.executorMode ?? "hosted"); }, [runtime?.agentMode, runtime?.executorMode]);
  const changed = agent !== (runtime?.agentMode ?? "none") || (!sim && executor !== (runtime?.executorMode ?? "hosted"));
  async function apply() {
    if (fixture) return;
    setBusy(true);
    const r = await v7.handover(taskId, { agent: agent === "none" ? null : agent, ...(sim ? {} : { executor }) }).catch(() => null);
    setBusy(false);
    if (!r || r.status === 0) return onChanged({ text: s("unreachable"), tone: "bad" });
    if (r.status !== 200) {
      const code = String((r.data as { error?: string } | null)?.error ?? "");
      return onChanged({ text: m(`ho_err_${code}`) ?? apiError(r, locale), tone: r.status === 409 ? "warn" : "bad" });
    }
    onChanged({ text: s("ho_done"), tone: "ok" });
  }
  return (
    <Card title={s("ho_h")}>
      <div className="space-y-3">
        <fieldset className="space-y-2" disabled={busy || disabled || fixture}>
          <legend className="text-xs text-fg-3">{s("ho_agent")}</legend>
          <div className="v7-choices v7-two">
            {(["hosted", "byo"] as const).map((a) => <label key={a} className="v7-choice"><input type="radio" name={`ho-agent-${taskId}`} checked={agent === a} onChange={() => setAgent(a)} /><span>{s(a === "hosted" ? "agent_hosted" : "agent_byo")}</span></label>)}
          </div>
        </fieldset>
        {!sim && (
          <fieldset className="space-y-2" disabled={busy || disabled || fixture}>
            <legend className="text-xs text-fg-3">{s("ho_executor")}</legend>
            <div className="v7-choices">
              {(["hosted", "agent_wallet", "browser"] as const).map((e) => <label key={e} className="v7-choice"><input type="radio" name={`ho-exec-${taskId}`} checked={executor === e} onChange={() => setExecutor(e)} /><span>{s(`exec_${e}`)}{e === "hosted" ? ` · ${s("ho_recommended")}` : ""}</span></label>)}
            </div>
          </fieldset>
        )}
        <div className="ag-actions"><button type="button" className="btn-ghost" disabled={!changed || busy || disabled || fixture} onClick={() => void apply()}>{busy ? s("loading") : s("ho_apply")}</button></div>
        <p className="ag-note">{s("ho_note")}</p>
      </div>
    </Card>
  );
}
