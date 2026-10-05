"use client";
/**
 * 四问卡（P3 / P-03）：每一问都有明确的数据来源——
 *  它接手了吗 = runtime.presence + runtime.executorMode/executor + 委托清单 counts；
 *  现在在做什么 = presence.currentActivity / waitingFor / nextCheckAt / lastDecisionAt；
 *  已经做成什么 = 视图 steps（买 / 卖确认数）+ 成交回执 + 任务持仓 + 买入授权 spent / 范围 budgetCap；
 *  需要我处理什么 = 已返回的 runtime.needsOwner；尚未收到 runtime 时不推断「没有待办」。
 */
import Link from "next/link";
import type { NeedsOwnerItem, TaskRuntime } from "@chaconne/core/verify";
import type { TaskPosition } from "@/lib/api-v2";
import { formatAmount, formatTime } from "@/lib/format";
import { assetByKey, type AssetEntry } from "@/lib/assets";
import { EXPLORER, short } from "@/lib/wallet";
import { Pill } from "@/components/ui";
import { budgetUsage, presenceKey, sortNeedsOwner } from "./runtimeModel";
import { useV7 } from "./useV7";
import styles from "./console.module.css";

export interface FourQuestionsProps {
  runtime: TaskRuntime | null;
  delegationCounts: { signaturesNeeded: number; signaturesDone: number } | null;
  delegationComplete: boolean | null;
  fills: { buy: number | null; sell: number | null; planned: number | null; latest: { txHash: string | null; at?: string | null } | null };
  positions: TaskPosition[] | null;
  budget: { capRaw: string | null; spentRaw: string | null; decimals: number | null; symbol: string };
  assets: AssetEntry[];
  sim: boolean;
  modeKnown?: boolean;
  onAction: (item: NeedsOwnerItem) => void;
}

export function FourQuestions(p: FourQuestionsProps) {
  const { s, m, locale } = useV7();
  const zh = locale === "zh";
  const pres = p.runtime?.presence ?? null;
  const unknown = zh ? "暂未获取" : "Not available yet";
  const presLabel = pres ? (m(presenceKey(pres)) ?? unknown) : (zh ? "等待运行状态" : "Waiting for agent status");
  const agentLabel = !pres ? unknown : pres.mode === "hosted" ? s("agent_hosted") : pres.mode === "byo" ? s("agent_byo") : s("agent_none");
  const execMode = p.runtime?.executorMode ?? null;
  const execLabel = p.sim ? (zh ? "观察模式，不执行交易" : "Observation only; no trades") : execMode ? (m(`exec_${execMode}`) ?? execMode) : p.runtime ? s("exec_none") : unknown;
  const execState = !p.sim && p.runtime?.executor?.state ? m(`exst_${p.runtime.executor.state}`) : null;
  const deleg = p.delegationComplete ? s("q1_deleg_done") : p.delegationCounts ? s("q1_deleg_partial", { done: p.delegationCounts.signaturesDone, needed: p.delegationCounts.signaturesNeeded }) : p.delegationComplete === false ? (zh ? "尚未完成" : "Not complete yet") : unknown;
  const needsKnown = Array.isArray(p.runtime?.needsOwner);
  const needs = sortNeedsOwner(p.runtime?.needsOwner);
  const ops = p.runtime?.needsOperator ?? [];
  const hosted = pres?.mode === "hosted" ? pres : null;
  const usage = p.budget.decimals !== null && p.budget.symbol ? budgetUsage(p.budget.capRaw, p.budget.spentRaw) : null;
  const sym = (k: string) => assetByKey(p.assets, k)?.displaySymbol ?? k.slice(-6);
  const holding = (x: TaskPosition) => {
    const decimals = assetByKey(p.assets, x.assetKey)?.tokenDecimals;
    return `${sym(x.assetKey)} ${decimals === undefined ? (zh ? "（数量待确认）" : "(quantity pending)") : formatAmount(x.netRaw, decimals, undefined, 6)}`;
  };
  const held = (p.positions ?? []).filter((x) => /^\d+$/.test(x.netRaw) && BigInt(x.netRaw) > 0n);
  const needsAttention = needs.some((n) => n.blocking);
  const running = (hosted && ["working", "waiting", "awaiting_fill"].includes(hosted.state)) || (pres?.mode === "byo" && pres.state === "online");
  const stateTone = needsAttention || ops.length > 0 ? "attn" : running ? "active" : "neutral";
  const activity = hosted?.state === "working" ? hosted.currentActivity ?? presLabel
    : hosted?.state === "waiting" ? hosted.waitingFor ?? presLabel
    : pres ? (pres.mode === "none" ? s("q2_idle") : presLabel)
    : (zh ? "收到 Agent 的状态后，这里会显示它的当前动作和下次检查时间。" : "The agent’s current action and next check will appear when its status arrives.");
  const feeBlocked = ops.includes("fee_budget_exhausted") || ops.includes("fee_cap_exceeded");
  return (
    <div className={styles.overview} data-testid="four-questions">
      <section className={styles.statusCard} data-tone={stateTone} aria-labelledby="q1">
        <div className={styles.cardEyebrow}>
          <h2 id="q1">{s("q1_h")}</h2>
          <span className={styles.mode}>{p.modeKnown === false ? (zh ? "模式待确认" : "Mode unconfirmed") : p.sim ? (zh ? "观察任务" : "Observation") : (zh ? "真实资金任务" : "Live task")}</span>
        </div>
        <p className={styles.presence}><span className={styles.stateDot} aria-hidden="true" />{!pres || pres.mode === "none" ? presLabel : `${agentLabel} · ${presLabel}`}</p>
        <div className={styles.currentActivity}>
          <h2 id="q2">{s("q2_h")}</h2>
          <p>{activity}</p>
          <dl className={styles.timing}>
            {hosted?.state !== "paused" && pres && pres.mode !== "none" && pres.nextCheckAt && <><dt>{s("q2_next_check")}</dt><dd>{formatTime(pres.nextCheckAt, locale)}</dd></>}
            {hosted?.lastDecisionAt && <><dt>{s("q2_last_decision")}</dt><dd>{formatTime(hosted.lastDecisionAt, locale)}</dd></>}
            {pres?.mode === "byo" && pres.lastResponseAt && <><dt>{s("q2_last_decision")}</dt><dd>{formatTime(pres.lastResponseAt, locale)}</dd></>}
          </dl>
        </div>
        <dl className={styles.assignment}>
          <dt>{s("q1_agent")}</dt><dd>{agentLabel}</dd>
          <dt>{s("q1_executor")}</dt><dd>{execLabel}{execState ? ` · ${execState}` : ""}</dd>
          {!p.sim && <><dt>{s("q1_delegation")}</dt><dd>{deleg}</dd></>}
        </dl>
      </section>
      <section className={styles.attentionCard} data-tone={needsAttention || ops.length ? "attn" : undefined} aria-labelledby="q4">
        <div className={styles.cardEyebrow}><h2 id="q4">{s("q4_h")}</h2>{needs.length > 0 && <span className={styles.count}>{needs.length}</span>}</div>
        {ops.length > 0 && <div className={styles.operatorNote}>
          <p>{s("q4_operator", { what: ops.map((o) => m(`op_${o}`) ?? o).join(zh ? "、" : ", ") })}</p>
          {feeBlocked && <p>{zh ? "平台费用拦截无需重复签名。委托清单中仍可能保留未完成项。" : "A platform fee block does not require signing again. The delegation checklist may still contain unfinished items."}</p>}
        </div>}
        {!needsKnown ? <p className={styles.attentionEmpty} data-testid="needs-unknown">{zh ? "待办状态尚未返回。确认后再判断是否需要你操作。" : "Your action list has not arrived yet. We cannot confirm whether anything needs your attention."}</p>
          : needs.length === 0 ? <p className={styles.attentionEmpty} data-testid="needs-none">{s("q4_none")}</p> : (
          <ul className={styles.needsList}>
            {needs.map((n, i) => (
              <li key={`${n.code}-${i}`}>
                <div className="ag-actions"><Pill tone={n.blocking ? "warn" : "info"}>{n.blocking ? s("no_blocking") : s("no_reminder")}</Pill><span>{n.text[locale]}</span></div>
                <NeedAction item={n} onAction={p.onAction} />
              </li>
            ))}
          </ul>
        )}
        {needsKnown && needs.length === 0 && <p className={styles.secondary}>{zh ? "需要授权、补充资金或确认撤销时，会在这里提醒你。" : "Requests to authorize, add funds, or confirm revocation will appear here."}</p>}
      </section>
      <section className={styles.outcomeCard} aria-labelledby="q3">
        <div className={styles.outcomeHeading}><h2 id="q3">{s("q3_h")}</h2><p>{zh ? "这里只计已确认的成交，分析结束不代表交易完成。" : "Only confirmed fills count here. A completed analysis is not a completed trade."}</p></div>
        <div className={styles.outcomes}>
          <div><h3>{s("q3_fills")}</h3>
            {p.fills.buy === null && p.fills.sell === null ? <p className={styles.secondary}>{zh ? "成交记录待获取" : "Fill records not available yet"}</p>
              : p.fills.buy === 0 && p.fills.sell === 0 ? <p>{s("q3_none")}</p>
              : <p>{s("q3_fills_v", { buy: p.fills.buy ?? "—", sell: p.fills.sell ?? "—", planned: p.fills.planned ?? "—" })}</p>}
            {p.fills.latest?.txHash && <a className={styles.receipt} href={`${EXPLORER}/tx/${p.fills.latest.txHash}`} target="_blank" rel="noreferrer">{s("q3_last_fill")} · {short(p.fills.latest.txHash)} ↗</a>}
          </div>
          <div><h3>{s("q3_positions")}</h3><p>{p.positions === null ? unknown : held.length > 0 ? held.map(holding).join(" · ") : (zh ? "暂无本任务持仓记录" : "No holdings recorded for this task")}</p></div>
          <div><h3>{s("q3_budget")}</h3><p>{p.sim ? (zh ? "观察模式，不使用交易本金" : "Observation does not spend trading funds") : usage && p.budget.decimals !== null ? s("q3_budget_v", { used: formatAmount(usage.used, p.budget.decimals, p.budget.symbol), left: formatAmount(usage.left, p.budget.decimals, p.budget.symbol) }) : (zh ? "已用与剩余预算待获取" : "Spent and remaining budget not available yet")}</p></div>
        </div>
      </section>
    </div>
  );
}

function NeedAction({ item, onAction }: { item: NeedsOwnerItem; onAction: (i: NeedsOwnerItem) => void }) {
  const { s, m } = useV7();
  const label = m(`no_action_${item.action.kind}`) ?? item.action.kind;
  if (item.action.kind === "create_new_task") return <Link className="btn-ghost mt-1 inline-flex h-8 items-center px-3 text-xs" href="/agent">{label}</Link>;
  if (item.action.kind === "reclaim_allowance" || item.action.kind === "top_up") return <Link className="btn-ghost mt-1 inline-flex h-8 items-center px-3 text-xs" href="/agent/funds#allowances">{label}</Link>;
  return <button type="button" className="btn-ghost mt-1 h-8 px-3 text-xs" onClick={() => onAction(item)} aria-label={`${label} · ${s("q4_h")}`}>{label}</button>;
}
