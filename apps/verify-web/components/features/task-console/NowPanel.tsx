"use client";
/**
 * 「现在」：它接手了吗 + 现在在做什么。数据来源：runtime.presence / executor / 委托清单；Agent 最近一句原话；任务阻塞项。
 * 运行状态未返回时不推断「已接手 / 没有待办」（v7 语义）。暂停不显示下次检查。
 */
import type { TaskRuntime } from "@chaconne/core/verify";
import { AgentSays } from "@/components/kit/AgentSays";
import { Blockers, type BlockerItem } from "@/components/kit/Blockers";
import { KeyValue } from "@/components/kit/KeyValue";
import { Panel } from "@/components/kit/Panel";
import { Timestamp } from "@/components/kit/Timestamp";
import { cn } from "@/lib/utils";
import { presenceText } from "@/lib/presenceText";
import { presenceKey } from "@/components/agent/tasks/v7/runtimeModel";
import { useV7 } from "@/components/agent/tasks/v7/useV7";

export function NowPanel({ runtime, sim, nextCheckAt, delegation, blockers, paused, latestQuote }: {
  runtime: TaskRuntime | null;
  sim: boolean;
  nextCheckAt: string | null;
  delegation: { complete: boolean | null; done: number | null; needed: number | null };
  blockers: BlockerItem[];
  paused: boolean;
  latestQuote: { text: string; at: string; who: string } | null;
}) {
  const { s, m, zh } = useV7();
  const pres = runtime?.presence ?? null;
  const unknown = zh ? "暂未获取" : "Not available yet";
  const presLabel = pres ? (m(presenceKey(pres)) ?? unknown) : (zh ? "等待运行状态" : "Waiting for agent status");
  const hosted = pres?.mode === "hosted" ? pres : null;
  const activity = presenceText(hosted?.state === "working" ? hosted.currentActivity : hosted?.state === "waiting" ? hosted.waitingFor : null, zh ? "zh" : "en");
  const agentLabel = !pres ? unknown : pres.mode === "hosted" ? s("agent_hosted") : pres.mode === "byo" ? s("agent_byo") : s("agent_none");
  const execMode = runtime?.executorMode ?? null;
  const execLabel = sim ? (zh ? "观察模式，不执行交易" : "Observation only; no trades") : execMode ? (m(`exec_${execMode}`) ?? (zh ? "未知方式" : "Unknown")) : runtime ? s("exec_none") : unknown;
  const execState = !sim && runtime?.executor?.state ? m(`exst_${runtime.executor.state}`) : null;
  const deleg = delegation.complete ? s("q1_deleg_done") : delegation.done !== null && delegation.needed !== null ? s("q1_deleg_partial", { done: delegation.done, needed: delegation.needed }) : delegation.complete === false ? (zh ? "尚未完成" : "Not complete yet") : unknown;
  const live = hosted ? ["working", "waiting", "awaiting_fill", "starting"].includes(hosted.state) : pres?.mode === "byo" && pres.state === "online";
  return (
    <Panel className="ch-now-panel" aria-label={zh ? "现在" : "Now"}>
      <Panel.Header eyebrow={s("q1_h")} title={
        <span className="ch-now-presence">
          <span className={cn("ch-now-presence-dot", live ? "bg-ok" : pres ? "bg-fg-3" : "bg-line-strong")} aria-hidden="true" />
          {presLabel}
        </span>
      } description={pres && pres.mode !== "none" ? agentLabel : undefined} />
      <Panel.Body className="ch-now-body">
        {activity ? <p className="ch-now-activity">{activity}</p> : null}
        {latestQuote ? (
          <AgentSays className="ch-now-quote" who={latestQuote.who} meta={<Timestamp at={latestQuote.at} mode="rel" />}>
            {latestQuote.text}
          </AgentSays>
        ) : null}
        {blockers.length > 0 ? (
          <div className="ch-now-blockers">
            <h3>{zh ? "在等什么" : "What it is waiting for"}</h3>
            <Blockers items={blockers} hideNextCheck={paused} />
          </div>
        ) : null}
        <KeyValue className="ch-now-details" dense items={[
          { label: s("q1_agent"), value: agentLabel },
          { label: s("q1_executor"), value: execState ? `${execLabel} · ${execState}` : execLabel },
          ...(!sim ? [{ label: s("q1_delegation"), value: deleg }] : []),
          ...(nextCheckAt ? [{ label: s("q2_next_check"), value: <Timestamp at={nextCheckAt} /> }] : []),
          ...(hosted?.lastDecisionAt ? [{ label: s("q2_last_decision"), value: <Timestamp at={hosted.lastDecisionAt} mode="rel" /> }] : []),
        ]} />
      </Panel.Body>
    </Panel>
  );
}
