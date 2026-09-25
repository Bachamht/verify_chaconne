"use client";
/**
 * /agent/tasks/[id]：阻塞项全量、nextCheckAt、执行器三态文案、授权（签 TradeMandate 草案）、prepare-step、
 * 停止按钮（说明：只阻止后续签发，已取走的证书仍可能可执行，彻底停止以链上撤销确认为准）。
 * V-32：标题 = 模板 · 资产 · 金额 × 步数；阻塞项本地化短句；金额与时间统一格式；异步按钮三态 + toast；PAUSED 不显示下次检查；
 *       SIMULATION 任务显示「不需要执行器」；原始 ISO / JSON 只在开发者视图。
 */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n";
import { agentTasks, mandates, notReady, type AgentTradeIntent, type MandateDraftView, type TaskCreated } from "@/lib/api-v2";
import { DecisionTimeline } from "./DecisionTimeline";
import { AgentBrief } from "./AgentBrief";
import { apiError } from "@/lib/errors";
import { formatAmount, formatTime } from "@/lib/format";
import { assetByKey, loadAssets, type AssetEntry } from "@/lib/assets";
import { conditionText } from "@/lib/conditions";
import { CHAIN_ID, connect, currentChainId, ensureChain, EXPLORER, sendGuardCall, short, signTypedData, waitReceipt } from "@/lib/wallet";
import { encodeRevoke } from "@/lib/mandate";
import { PLANGUARD_ADDRESS } from "@/lib/planGuardAbi";
import { useAccount } from "@/lib/useAccount";
import type { TradeMandate } from "@chaconne/core/verify";
import { Card, Pill } from "@/components/ui";
import { LoadingState, ModeTag, NotReady, Skeleton, Toast, useToast } from "../shared";
import { Blockers } from "./Blockers";
import { blockerSentence, statusLabel, taskTitle } from "./taskTitle";
import { taskSummary } from "./taskSummary";
import { policySentence } from "@/lib/policyText";

const TONE: Record<string, "ok" | "warn" | "bad" | "info" | "brand" | "neutral"> = { ACTIVE: "ok", STEP_PREPARED: "ok", COMPLETED: "ok", WAITING: "warn", PAUSED: "warn", AWAITING_AUTHORIZATION: "info", DRAFT: "neutral", PARTIAL: "info", REVOKE_PENDING: "bad", REVOKED: "bad", EXPIRED: "neutral", CANCELLED: "neutral" };

export function TaskDetail({ id }: { id: string }) {
  const { locale, t } = useI18n();
  const zh = locale === "zh";
  const account = useAccount();
  const router = useRouter();
  const [assets, setAssets] = useState<AssetEntry[]>([]);
  const [state, setState] = useState<{ kind: "busy" } | { kind: "nr"; http: number } | { kind: "err"; msg: string } | { kind: "ok"; v: TaskCreated }>({ kind: "busy" });
  const [pending, setPending] = useState<"prepare" | "pause" | "resume" | "cancel" | "authorize" | "revoke" | "delete" | null>(null);
  const [intents, setIntents] = useState<AgentTradeIntent[] | null>(null);
  /** 成交回执：授权计划里每一步的链上交易（用户要「成交后一键打开区块浏览器」） */
  const [fills, setFills] = useState<Array<{ mandateId: string; stepIndex: string; state: string; txHash: string | null; spent: string | null; received: string | null }>>([]);
  const [toast, setToast] = useToast();
  useEffect(() => { void loadAssets().then((r) => setAssets(r.assets)); }, []);
  const load = useCallback(async () => {
    // 钱包账户化：带上已连接钱包，代理按它当调用方（不依赖 cookie）
    const r = await agentTasks.get(id, account).catch(() => null);
    if (!r || r.status === 0) return setState((s) => (s.kind === "ok" ? s : { kind: "nr", http: 0 }));
    if (notReady(r)) return setState({ kind: "nr", http: r.status });
    if (r.status !== 200) return setState({ kind: "err", msg: apiError(r, locale) });
    setState({ kind: "ok", v: r.data });
    // CV-D16：有授权范围的任务才有意图；读不到（旧部署 404）就不显示
    if (r.data.task.scope) {
      const li = await agentTasks.intents(id, account).catch(() => null);
      setIntents(li && li.status === 200 ? li.data.intents : null);
    }
    if (r.data.task.mandateIds.length > 0) {
      const views = await Promise.all(r.data.task.mandateIds.map((m) => mandates.get(m).catch(() => null)));
      setFills(views.flatMap((v) => (v && v.status === 200 ? v.data.steps.filter((s) => s.txHash || s.state === "SUBMITTED" || s.state === "CONFIRMED").map((s) => { const ev = (s.receipt as { event?: { spent?: string; received?: string } } | null)?.event; return { mandateId: v.data.mandateId, stepIndex: s.stepIndex, state: s.state, txHash: s.txHash, spent: ev?.spent ?? null, received: ev?.received ?? null }; }) : [])));
    }
  }, [id, locale, account]);
  useEffect(() => {
    void load();
    const i = setInterval(() => void load(), 15_000);
    return () => clearInterval(i);
  }, [load]);

  async function wallet(): Promise<`0x${string}`> {
    const a = (account ?? (await connect())) as `0x${string}`;
    if ((await currentChainId()) !== CHAIN_ID) await ensureChain();
    return a;
  }
  async function stop(kind: "pause" | "resume" | "cancel") {
    setPending(kind);
    const r = await agentTasks[kind](id).catch(() => null);
    setPending(null);
    if (!r || r.status === 0) return setToast({ text: t("ag_service_unreachable"), tone: "bad" });
    if (r.status !== 200) return setToast({ text: apiError(r, locale), tone: "bad" });
    setToast({ text: kind === "pause" ? t("ag_paused_ok") : kind === "resume" ? t("ag_resumed_ok") : t("ag_cancelled_ok"), tone: "ok" });
    void load();
  }
  async function authorize(draft: MandateDraftView) {
    setPending("authorize");
    try {
      const a = await wallet();
      if (a.toLowerCase() !== draft.typedData.message.owner.toLowerCase()) return setToast({ text: zh ? "已连接钱包不是这份授权的 owner" : "Connected wallet is not this mandate's owner", tone: "warn" });
      const m = draft.typedData.message;
      const big = { ...m, budgetCap: BigInt(m.budgetCap), perStepCap: BigInt(m.perStepCap), maxSteps: Number(m.maxSteps), validFrom: BigInt(m.validFrom), deadline: BigInt(m.deadline), nonce: BigInt(m.nonce) };
      const sig = await signTypedData(a, draft.typedData.domain, draft.typedData.types, "TradeMandate", big as unknown as Record<string, unknown>);
      const r = await agentTasks.authorize(id, { typedData: draft.typedData, signature: sig, outputSet: draft.outputSet, clientRequestId: `web-auth-${id}` });
      if (r.status !== 201 && r.status !== 200) return setToast({ text: apiError(r, locale), tone: "bad" });
      setToast({ text: zh ? "授权已登记；执行由你的钱包或 Agent 完成。" : "Authorization registered; execution is done by your wallet or agent.", tone: "ok" });
      void load();
    } catch (e) {
      setToast({ text: String((e as { message?: string })?.message ?? e), tone: "bad" });
    } finally {
      setPending(null);
    }
  }
  async function revoke(mandate: TradeMandate) {
    setPending("revoke");
    try {
      const a = await wallet();
      const h = await sendGuardCall(a, PLANGUARD_ADDRESS as `0x${string}`, encodeRevoke(mandate));
      await waitReceipt(h);
      setToast({ text: `${zh ? "链上已撤销" : "Revoked on-chain"} ${h.slice(0, 10)}…`, tone: "ok" });
      void load();
    } catch (e) {
      setToast({ text: String((e as { message?: string })?.message ?? e), tone: "bad" });
    } finally {
      setPending(null);
    }
  }
  async function remove() {
    if (state.kind !== "ok") return;
    const running = !["COMPLETED", "CANCELLED", "REVOKED", "EXPIRED"].includes(state.v.task.status);
    if (!window.confirm(running ? (zh ? "这个任务还在运行：删除会先取消它（服务侧停止签发；已取走的证书到期前仍可能执行），然后从列表移除。继续？" : "This task is still running: deleting cancels it first (issuance stops; pulled certificates may execute until they expire), then removes it from your lists. Continue?") : (zh ? "从列表移除这个任务？记录与证据保留，这一页仍可打开。" : "Remove this task from your lists? Records and evidence are kept; this page stays open."))) return;
    setPending("delete");
    const r = await agentTasks.archive(id).catch(() => null);
    setPending(null);
    if (!r || r.status !== 200) return setToast({ text: r ? apiError(r, locale) : t("ag_service_unreachable"), tone: "bad" });
    router.push("/agent/tasks");
  }
  async function prepare() {
    setPending("prepare");
    const r = await agentTasks.prepareStep(id).catch(() => null);
    setPending(null);
    if (!r || r.status === 0) return setToast({ text: t("ag_service_unreachable"), tone: "bad" });
    if (notReady(r)) return setToast({ text: `${t("ag_not_ready_h")} · POST /v1/tasks/:id/prepare-step`, tone: "warn" });
    const d = r.data;
    if (d.taskStatus === "PAUSED") setToast({ text: t("ag_eval_paused"), tone: "warn" });
    else if (d.status === "READY") setToast({ text: d.mode === "SIMULATION" ? t("ag_eval_sim_ready") : t("ag_eval_ready"), tone: "ok" });
    else {
      const first = d.blockers?.[0];
      const why = first ? blockerSentence(first, locale) : (d.message ?? d.error ?? (zh ? "条件未满足" : "conditions not met"));
      setToast({ text: t("ag_eval_wait", { why }), tone: "warn" });
    }
    void load();
  }

  if (state.kind === "busy") return <div className="space-y-3" aria-busy="true"><LoadingState onRetry={() => void load()} /><div className="card"><Skeleton lines={4} /></div></div>;
  if (state.kind === "nr") return <NotReady what={`GET /v1/tasks/${id}`} status={state.http} compact={false} onRetry={() => void load()} />;
  if (state.kind === "err") return <Card><p className="text-sm text-bad">{state.msg}</p><Link className="mt-2 inline-block text-sm underline" href="/agent/tasks">{t("ag_back_tasks")}</Link></Card>;
  const { task, mandateDraft, thesisDraft, budgetAllocation } = state.v;
  const mode = state.v.mode ?? (mandateDraft || task.mandateIds.length ? "LIVE" : "SIMULATION");
  const sim = mode === "SIMULATION";
  const stoppable = ["ACTIVE", "WAITING", "STEP_PREPARED", "PARTIAL"].includes(task.status);
  const paused = task.status === "PAUSED";
  const stable = assetByKey(assets, task.goal?.budget?.inputAssetKeys?.[0]);
  const steps = state.v.steps;
  const summary = taskSummary(state.v, locale);
  return (
    <>
      <header>
        <div className="ag-actions"><h1 className="ag-h1 text-xl">{taskTitle(task, state.v.params, assets, locale)}</h1><Pill tone={TONE[task.status] ?? "neutral"}>{statusLabel(task.status, locale)}</Pill><ModeTag mode={mode} /></div>
        <p className="ag-lead">{steps ? `${t("ag_steps_done", { done: steps.confirmed, max: steps.planned })} · ` : ""}{zh ? "条件" : "conditions"} {task.conditions.items.length} · {zh ? "创建" : "created"} {formatTime(task.createdAt, locale)} · {zh ? "更新" : "updated"} {formatTime(task.updatedAt, locale)}</p>
      </header>
      <Card title={zh ? "现在在哪一步" : "Where this task stands"} className="ag-summary">
        <dl className="ag-kv">
          <dt>{zh ? "进度" : "Progress"}</dt><dd>{summary.progress}</dd>
          <dt>{zh ? "每笔交易前" : "Before every trade"}</dt><dd>{policySentence(state.v.params, locale)}</dd>
          <dt>{zh ? "谁来执行" : "Who executes"}</dt><dd>{summary.executor}</dd>
          <dt>{zh ? "还缺什么" : "What is missing"}</dt><dd>{summary.missing ?? (zh ? "不缺；按条件等待或行动。" : "Nothing; it waits or acts by its conditions.")}</dd>
          <dt>{zh ? "下一步" : "Next"}</dt><dd>{summary.next}</dd>
        </dl>
      </Card>
      {task.scope && (
        <Card title={zh ? "授权范围（签名只覆盖这些）" : "Authorized scope (only this is signed)"}>
          <p className="text-sm">{task.scope.objective}</p>
          <dl className="ag-kv mt-2">
            <dt>{zh ? "允许买入" : "Allowed assets"}</dt><dd>{task.scope.outputAssetKeys.map((k) => assetByKey(assets, k)?.displaySymbol ?? k.slice(-6)).join(" / ")}</dd>
            <dt>{zh ? "总额 / 每笔上限" : "Total / per-step cap"}</dt><dd>{formatAmount(task.scope.budgetCapRaw, stable?.tokenDecimals ?? 6, stable?.displaySymbol)} / {formatAmount(task.scope.perStepCapRaw, stable?.tokenDecimals ?? 6, stable?.displaySymbol)} · {zh ? `最多 ${task.scope.maxSteps} 笔` : `up to ${task.scope.maxSteps} steps`}</dd>
            <dt>{zh ? "期限" : "Deadline"}</dt><dd>{formatTime(task.scope.deadline, locale)}</dd>
            <dt>{zh ? "卖出" : "Selling"}</dt><dd>{task.scope.allowSell ? (zh ? "允许 agent 提出（需另签卖出授权）" : "the agent may propose it (separate sell authorization)") : (zh ? "不允许" : "not allowed")}</dd>
            <dt>{zh ? "信任档位" : "Trust tier"}</dt><dd>{task.scope.trustTier === "platform_only" ? (zh ? "只信 Chaconne 核验过的事实" : "only facts verified by Chaconne") : task.scope.trustTier === "agent_data" ? (zh ? "也接受 agent 带来源的数据声明（未核验）" : "also sourced data claims from the agent (unverified)") : (zh ? "也接受 agent 的研究结论（未核验）" : "also the agent's research conclusions (unverified)")}</dd>
            <dt>{zh ? "签发" : "Issuance"}</dt><dd>{task.scope.issuance === "agent" ? (zh ? "只在 agent 提交交易意图后" : "only on agent-submitted trade intents") : (zh ? "平台按计划条件" : "platform, by the plan conditions")}</dd>
            {task.scope.hardConditions.length > 0 && <><dt>{zh ? "硬约束" : "Hard constraints"}</dt><dd>{task.scope.hardConditions.map((c, i) => <span key={i} className="block">{conditionText(c, locale)}</span>)}</dd></>}
          </dl>
          <p className="ag-note mt-2">{zh ? "PlanGuard 对经该合约的每一步都执行这个范围；agent 自己持有完整私钥、绕开合约发的交易不在约束内。" : "PlanGuard enforces this scope on every step that goes through the contract; transactions an agent sends from a wallet whose full private key it holds, outside the contract, are not constrained."}</p>
        </Card>
      )}
      {task.scope?.issuance === "agent" && <AgentBrief task={task} view={state.v} intents={intents} assets={assets} stable={stable} onUpdated={() => void load()} />}
      <Card title={zh ? "动作" : "Actions"}>
        <div className="ag-actions">
          {mandateDraft && task.status === "AWAITING_AUTHORIZATION" && <button className="btn" disabled={pending !== null} onClick={() => authorize(mandateDraft)}>{pending === "authorize" ? t("wallet_connecting") : zh ? "签署授权（TradeMandate）" : "Sign the authorization (TradeMandate)"}</button>}
          {stoppable && <button className="btn-ghost" disabled={pending !== null} onClick={prepare}>{pending === "prepare" ? t("ag_evaluating") : t("ag_evaluate_now")}</button>}
          {stoppable && <button className="btn-ghost" disabled={pending !== null} onClick={() => stop("pause")}>{pending === "pause" ? t("ag_working") : t("task_pause")}</button>}
          {paused && <button className="btn-ghost" disabled={pending !== null} onClick={() => stop("resume")}>{pending === "resume" ? t("ag_working") : t("task_resume")}</button>}
          {(stoppable || paused) && <button className="btn-ghost" disabled={pending !== null} onClick={() => stop("cancel")}>{pending === "cancel" ? t("ag_working") : t("task_cancel")}</button>}
          <button className="btn-ghost text-bad" disabled={pending !== null} onClick={() => void remove()}>{pending === "delete" ? t("ag_working") : (zh ? "删除" : "Delete")}</button>
          {task.mandateIds.length > 0 && PLANGUARD_ADDRESS && <RevokeButton mandateId={task.mandateIds[task.mandateIds.length - 1]!} onRevoke={revoke} disabled={pending !== null} label={pending === "revoke" ? t("tx_pending") : t("task_revoke")} />}
        </div>
        {!sim && <p className="ag-warn mt-3">{t("ag_stop_note")}</p>}
      </Card>
      <div className="ag-grid-2">
        <Card title={zh ? "现在在等什么" : "What it is waiting for"}>
          <Blockers blockers={task.blockers} nextCheckAt={task.nextCheckAt} paused={paused} />

        </Card>
        <Card title={sim ? (zh ? "执行" : "Execution") : (zh ? "执行器" : "Executor")}>
          {sim ? <p className="ag-note">{t("ag_exec_sim")}</p> : (
            <>
              <div className="ag-actions"><Pill tone={task.executorPresence === "online" ? "ok" : task.executorPresence === "awaiting_signature" ? "info" : "neutral"}>{task.executorPresence === "online" ? (zh ? "在线" : "online") : task.executorPresence === "awaiting_signature" ? (zh ? "等你签名" : "awaiting your signature") : (zh ? "离线" : "offline")}</Pill></div>
              <p className="ag-note mt-2">{task.executorPresence === "online" ? t("ag_exec_online") : task.executorPresence === "awaiting_signature" ? t("ag_exec_awaiting") : t("ag_exec_offline")}</p>
              <p className="ag-note">{zh ? "执行器状态是信息项，不阻塞签发。" : "Presence is informational; it never blocks issuance."}</p>
            </>
          )}
          <dl className="ag-kv mt-3">
            <dt>{zh ? "授权" : "authorizations"}</dt><dd>{task.mandateIds.length ? task.mandateIds.map((m) => <Link key={m} className="mono underline" href={`/tasks/${m}`}>{m.slice(0, 12)}… </Link>) : "—"}</dd>
            {task.budgetGroupId && <><dt>{zh ? "资金组" : "budget group"}</dt><dd><Link className="underline" href={`/agent/funds?group=${task.budgetGroupId}`}>{zh ? "查看资金组" : "open budget group"}</Link></dd></>}
            {budgetAllocation && <><dt>{t("ag_reserved")}</dt><dd>{budgetAllocation.reservedRaw ? formatAmount(budgetAllocation.reservedRaw, stable?.tokenDecimals ?? 6, stable?.displaySymbol) : "—"} · {budgetAllocation.state}</dd></>}
          </dl>
        </Card>
      </div>
      {!sim && task.mandateIds.length > 0 && (
        <Card title={zh ? `成交回执 · ${fills.filter((f) => f.txHash).length}` : `Fills · ${fills.filter((f) => f.txHash).length}`}>
          {fills.length === 0 ? <p className="ag-note">{zh ? "还没有上链的成交。Agent 拿到步骤证书并发出交易后，这里会列出每一笔的交易哈希，点开就是区块浏览器。" : "No on-chain fill yet. Once the agent takes a step certificate on-chain, every fill lists here with its transaction hash and a block-explorer link."}</p> : (
            <ul className="ag-list text-sm">
              {fills.map((f) => (
                <li key={`${f.mandateId}:${f.stepIndex}`} className="ag-actions">
                  <span className="mono">#{f.stepIndex}</span>
                  <Pill tone={f.state === "CONFIRMED" ? "ok" : f.state === "SUBMITTED" ? "info" : "neutral"}>{f.state === "CONFIRMED" ? (zh ? "链上已确认" : "confirmed") : f.state === "SUBMITTED" ? (zh ? "已发出，等确认" : "submitted") : f.state}</Pill>
                  {f.txHash ? <a className="mono underline" href={`${EXPLORER}/tx/${f.txHash}`} target="_blank" rel="noreferrer">{short(f.txHash)} ↗</a> : <span className="text-fg-3">—</span>}
                  {f.spent && <span className="mono text-xs text-fg-2">{zh ? "花费" : "spent"} {formatAmount(f.spent, stable?.tokenDecimals ?? 6, stable?.displaySymbol)}{f.received ? ` → ${f.received}` : ""}</span>}
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
      {task.scope && <DecisionTimeline turn={state.v.agentTurn ?? null} intents={intents} timeline={state.v.timeline} assets={assets} stable={stable} trustTier={task.scope.trustTier} issuance={task.scope.issuance} txByRef={Object.fromEntries(fills.filter((f) => f.txHash).map((f) => [`${f.mandateId}:${f.stepIndex}`, f.txHash!]))} />}
      {task.scope?.issuance === "agent" ? (
        <details className="ag-exec-details">
          <summary className="cursor-pointer text-sm font-semibold">{zh ? `执行详情：计划条件 ${task.conditions.items.length} 项、证书与签发方式` : `Execution details: ${task.conditions.items.length} plan condition(s), certificates and issuance`}</summary>
          <div className="mt-3">
            <ul className="ag-list text-sm">{task.conditions.items.map((c, i) => <li key={i}>{conditionText(c, locale)}</li>)}</ul>
            <p className="ag-note mt-2">{zh ? "计划条件在签名之外，对 agent 的意图不阻塞、只记偏离；硬约束在「授权范围」里。每一笔意图过四道核验后才签步骤证书；签证书不等于发交易。" : "Plan conditions are outside the signature; they never block an intent, deviations are only recorded. Hard constraints live in the scope card. Every intent passes four checks before a step certificate is signed; a certificate is not a transaction."}</p>
            <p className="mt-2 text-sm"><a className="underline" href={`/api/verify/v1/tasks/${task.id}/bundle${account ? `?owner=${account.toLowerCase()}` : ""}`} target="_blank" rel="noreferrer">{zh ? "导出决策记录（JSON）" : "Export the decision bundle (JSON)"}</a> · <Link className="underline" href="/verify-bundle">{zh ? "离线验证" : "Verify offline"}</Link><span className="ag-note block">{zh ? "决策记录 = 目标与范围、策略全部版本、每一轮、每条意图的依据与四道核验、证书与成交回执；bundleHash 覆盖全部内容，可离线复算。" : "The decision bundle = goal and scope, every strategy version, every turn, every intent's basis and four checks, certificates and fills; bundleHash covers all of it and can be recomputed offline."}</span></p>
          </div>
        </details>
      ) : (
        <Card title={`${t("ag_conditions")} · ${task.conditions.items.length}`}>
          <ul className="ag-list text-sm">{task.conditions.items.map((c, i) => <li key={i}>{conditionText(c, locale)}</li>)}</ul>
          {task.scope && <p className="ag-note mt-2">{zh ? "这些是计划条件，在签名之外：可以改，不用重签；硬约束在上面的「授权范围」里。" : "These are plan conditions, outside the signature: they can change without re-signing; hard constraints are in the scope card above."}</p>}
        </Card>
      )}
      {thesisDraft && (
        <Card title={zh ? "理由卡" : "Thesis"} right={<Pill tone={thesisDraft.status === "holds" ? "ok" : thesisDraft.status === "invalidated" ? "warn" : "neutral"}>{thesisDraft.status === "holds" ? t("ag_premise_holds") : thesisDraft.status === "invalidated" ? t("ag_premise_invalidated") : thesisDraft.status === "expired" ? statusLabel("EXPIRED", locale) : t("ag_premise_unknown")}</Pill>}>
          <p className="text-sm">{thesisDraft.goal}</p>
          <p className="ag-note">{thesisDraft.rationale}</p>
          <ul className="ag-list mt-2 text-xs">{thesisDraft.premises.map((p) => {
            // 时间门（session / 步间隔 / 事件与财报窗口 / 联储静默期）只是信息项，永远不算「失效」
            const timing = (p.kind as string) === "timing";
            return <li key={p.id}><Pill tone={timing ? "neutral" : p.status === "holds" ? "ok" : p.status === "invalidated" ? "warn" : "neutral"}>{timing ? t("ag_premise_timing") : p.kind === "machine" ? t("ag_premise_machine") : t("ag_premise_research")}{timing ? "" : ` · ${p.status === "holds" ? t("ag_premise_holds") : p.status === "invalidated" ? t("ag_premise_invalidated") : t("ag_premise_unknown")}`}</Pill> {p.condition ? conditionText(p.condition, locale) : p.text}{timing && <span className="text-fg-3"> · {t("ag_premise_timing_note")}</span>}</li>;
          })}</ul>
          <p className="ag-note mt-2">{zh ? "到期" : "valid until"} {formatTime(thesisDraft.validUntil, locale)} · {thesisDraft.onInvalidation === "pause_issuance" ? t("ag_thesis_on_pause_issuance") : thesisDraft.onInvalidation === "draft_exit" ? t("ag_thesis_on_draft_exit") : t("ag_thesis_on_notify")}</p>
        </Card>
      )}
      <Toast msg={toast} onClose={() => setToast(null)} />
    </>
  );
}

/** 链上撤销需要 mandate 原文：从 v5 授权接口读 */
function RevokeButton({ mandateId, onRevoke, label, disabled }: { mandateId: string; onRevoke: (m: TradeMandate) => void; label: string; disabled?: boolean }) {
  const [m, setM] = useState<TradeMandate | null>(null);
  useEffect(() => {
    mandates.get(mandateId).then((r) => { if (r.status === 200 && r.data.mandate) setM(r.data.mandate); }).catch(() => undefined);
  }, [mandateId]);
  if (!m) return null;
  return <button className="btn-ghost text-bad" disabled={disabled} onClick={() => onRevoke(m)}>{label}</button>;
}
