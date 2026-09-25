"use client";
/**
 * 「Agent 正在怎样处理目标」（CV-D16 批次 6）：目标与策略（版本）→ 我的 Agent（谁接管、最近回应、能否自行执行）→ 最新判断 / 正在调查 / 计划变化 /
 * 下一次检查 → 资金进展（已投入 / 剩余 / 为什么保留）→ 给 Agent 补充要求（追加进策略，留版本）。
 * 三个状态分开显示：钱包已连接 ≠ 执行器在线 ≠ Agent 正在处理。「到了预定发布时间」与「拿到实际值」也分开说。
 */
import { useState } from "react";
import { useI18n } from "@/lib/i18n";
import { agentTasks, type AgentTradeIntent, type TaskCreated } from "@/lib/api-v2";
import { apiError } from "@/lib/errors";
import { formatAmount, formatTime } from "@/lib/format";
import type { Task } from "@chaconne/core/verify";
import type { AssetEntry } from "@/lib/assets";
import { Card, Pill } from "@/components/ui";
import { turnReasonLabel, turnStateLabel } from "./decisionTimelineLabels";

export function AgentBrief({ task, view, intents, stable, onUpdated }: { task: Task; view: TaskCreated; intents: AgentTradeIntent[] | null; assets: AssetEntry[]; stable: AssetEntry | null | undefined; onUpdated: () => void }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const brief = task.brief ?? null;
  const turn = view.agentTurn ?? null;
  const [extra, setExtra] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const dec = stable?.tokenDecimals ?? 6;
  const sym = stable?.displaySymbol;
  const spent = (view.mandates ?? []).reduce((a, m) => a + BigInt(m.spent ?? "0"), 0n);
  const cap = task.scope ? BigInt(task.scope.budgetCapRaw) : 0n;
  const lastIntent = intents?.[0] ?? null;
  const latestJudgement = turn?.response?.note ?? lastIntent?.decision.rationale ?? null;
  const investigating = turn?.state === "needs_evidence" ? turn.response?.requestedEvidence ?? [] : [];
  const nextCheck = task.nextCheckAt ? formatTime(task.nextCheckAt, locale) : null;
  const agentState: "processing" | "accepted_idle" | "none" = brief?.agent ? (turn && (turn.state === "awaiting_agent") ? "accepted_idle" : "processing") : "none";
  async function append() {
    if (!extra.trim() || !brief) return;
    setBusy(true);
    setMsg(null);
    const text = `${brief.strategy?.text ?? ""}${brief.strategy?.text ? "\n\n" : ""}${zh ? "补充要求" : "Additional requirement"} (${new Date().toISOString().slice(0, 10)}): ${extra.trim()}`;
    const r = await agentTasks.updateBrief(task.id, { strategy: text, note: zh ? "owner 补充要求" : "owner added a requirement" }).catch(() => null);
    setBusy(false);
    if (!r || r.status !== 200) return setMsg(r ? apiError(r, locale) : (zh ? "服务不可达" : "service unreachable"));
    setExtra("");
    onUpdated();
  }
  return (
    <Card title={zh ? "Agent 正在怎样处理目标" : "How the agent is handling the goal"} right={brief?.agent ? <Pill tone={agentState === "processing" ? "ok" : "info"}>{brief.agent.name.slice(0, 24)}</Pill> : <Pill tone="warn">{zh ? "等待接管" : "no agent yet"}</Pill>}>
      <dl className="ag-kv">
        <dt>{zh ? "我的 Agent" : "My agent"}</dt><dd>{brief?.agent ? `${brief.agent.name} · ${zh ? "接管于" : "took over"} ${formatTime(brief.agent.acceptedAt, locale)} · ${zh ? "最近回应" : "last response"} ${formatTime(brief.agent.lastResponseAt, locale)}` : (zh ? "还没有 Agent 接管。你的 Agent 用 MCP 的 report_agent_status accepted 报名字接管；没有 Agent 也可以在 /start 自己扮演一轮。" : "No agent has taken over yet. Your agent takes over with report_agent_status accepted; without one you can play a round yourself on /start.")}</dd>
        <dt>{zh ? "目标" : "Objective"}</dt><dd>{task.scope?.objective}</dd>
        <dt>{zh ? "策略" : "Strategy"}</dt><dd>{brief?.strategy ? <><span className="whitespace-pre-wrap">{brief.strategy.text}</span><span className="ag-note block">v{brief.strategy.version} · {brief.strategy.by === "agent" ? (zh ? "agent 修订" : "revised by the agent") : (zh ? "你写的" : "written by you")} · {formatTime(brief.strategy.at, locale)}{brief.strategyHistory.length > 1 ? ` · ${zh ? `共 ${brief.strategyHistory.length} 版` : `${brief.strategyHistory.length} versions`}` : ""}</span></> : (zh ? "未写；由 Agent 自己制定。" : "Not written; the agent sets its own.")}</dd>
        <dt>{zh ? "当前计划" : "Current plan"}</dt><dd>{brief?.currentPlan ? <>{brief.currentPlan.text}<span className="ag-note block">{formatTime(brief.currentPlan.at, locale)}</span></> : (zh ? "Agent 还没有提交计划。" : "The agent has not submitted a plan yet.")}</dd>
        <dt>{zh ? "最新判断" : "Latest judgement"}</dt><dd>{turn ? <><Pill tone={turn.state === "awaiting_agent" ? "info" : turn.state === "no_response" ? "warn" : "neutral"}>{turnStateLabel(turn.state, locale)}</Pill> <span className="text-fg-2">{turnReasonLabel(turn.reason, locale)}</span>{latestJudgement ? <span className="block">{latestJudgement}</span> : null}</> : (zh ? "还没有一轮。真实任务授权后、模拟任务建好后开始。" : "No turn yet. Starts after authorization (live) or creation (simulation).")}</dd>
        {investigating.length > 0 && <><dt>{zh ? "正在调查" : "Investigating"}</dt><dd>{investigating.join("；")}</dd></>}
        <dt>{zh ? "下一次检查" : "Next check"}</dt><dd>{turn?.state === "awaiting_agent" ? (zh ? `等 Agent 回应（${formatTime(turn.respondBy, locale)} 前）` : `waiting for the agent (by ${formatTime(turn.respondBy, locale)})`) : nextCheck ?? (zh ? "关注的事件临近、到点或改期时叫醒 Agent；到点只是提醒它核实实际值。" : "The agent is woken when a watched event approaches, arrives or is rescheduled; arrival only asks it to verify the actual value.")}{brief?.watch.kinds.length ? <span className="ag-note block">{zh ? "关注：" : "watching: "}{brief.watch.kinds.join(", ")}</span> : null}</dd>
        <dt>{zh ? "资金进展" : "Budget progress"}</dt><dd>{zh ? "已投入" : "invested"} {formatAmount(spent.toString(), dec, sym)} · {zh ? "剩余" : "remaining"} {formatAmount((cap - spent).toString(), dec, sym)} · {view.steps ? `${view.steps.confirmed}/${task.scope?.maxSteps ?? view.steps.planned} ${zh ? "笔" : "steps"}` : ""}{turn?.state === "declined" && turn.response ? <span className="ag-note block">{zh ? "保留资金的原因：" : "why cash is kept: "}{turn.response.note}</span> : null}</dd>
      </dl>
      <div className="mt-3">
        <p className="text-sm font-semibold">{zh ? "给 Agent 补充要求" : "Add a requirement for the agent"}</p>
        <textarea className="field mt-1 w-full" rows={2} maxLength={1000} value={extra} onChange={(e) => setExtra(e.target.value)} placeholder={zh ? "例：本周不要在 FOMC 当天买" : "e.g. Do not buy on FOMC day this week"} />
        <div className="ag-actions mt-2"><button className="btn-ghost" disabled={busy || !extra.trim() || !brief} onClick={append}>{busy ? "…" : (zh ? "追加到策略（留版本）" : "Append to the strategy (versioned)")}</button><span className="ag-note">{zh ? "在签名之外，不用重签；Agent 下一轮会读到。" : "Outside the signature, no re-signing; the agent reads it on its next turn."}</span></div>
        {msg && <p className="text-sm text-bad" role="alert">{msg}</p>}
      </div>
    </Card>
  );
}
