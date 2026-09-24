"use client";
/**
 * /agent/tasks/[id]：阻塞项全量、nextCheckAt、执行器三态文案、授权（签 TradeMandate 草案）、prepare-step、
 * 停止按钮（说明：只阻止后续签发，已取走的证书仍可能可执行，彻底停止以链上撤销确认为准）。
 * V-32：标题 = 模板 · 资产 · 金额 × 步数；阻塞项本地化短句；金额与时间统一格式；异步按钮三态 + toast；PAUSED 不显示下次检查；
 *       SIMULATION 任务显示「不需要执行器」；原始 ISO / JSON 只在开发者视图。
 */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { agentTasks, mandates, notReady, type MandateDraftView, type PrepareStepView, type TaskCreated } from "@/lib/api-v2";
import { apiError } from "@/lib/errors";
import { formatAmount, formatTime } from "@/lib/format";
import { assetByKey, loadAssets, type AssetEntry } from "@/lib/assets";
import { conditionText } from "@/lib/conditions";
import { CHAIN_ID, connect, currentChainId, ensureChain, sendGuardCall, signTypedData, waitReceipt } from "@/lib/wallet";
import { encodeRevoke } from "@/lib/mandate";
import { PLANGUARD_ADDRESS } from "@/lib/planGuardAbi";
import { useAccount } from "@/lib/useAccount";
import type { TradeMandate } from "@chaconne/core/verify";
import { Card, Json, Pill } from "@/components/ui";
import { LoadingState, ModeTag, NotReady, Skeleton, Toast, useToast } from "../shared";
import { Blockers } from "./Blockers";
import { blockerSentence, statusLabel, taskTitle } from "./taskTitle";

const TONE: Record<string, "ok" | "warn" | "bad" | "info" | "brand" | "neutral"> = { ACTIVE: "ok", STEP_PREPARED: "ok", COMPLETED: "ok", WAITING: "warn", PAUSED: "warn", AWAITING_AUTHORIZATION: "info", DRAFT: "neutral", PARTIAL: "info", REVOKE_PENDING: "bad", REVOKED: "bad", EXPIRED: "neutral", CANCELLED: "neutral" };

export function TaskDetail({ id }: { id: string }) {
  const { locale, t } = useI18n();
  const zh = locale === "zh";
  const account = useAccount();
  const [assets, setAssets] = useState<AssetEntry[]>([]);
  const [state, setState] = useState<{ kind: "busy" } | { kind: "nr"; http: number } | { kind: "err"; msg: string } | { kind: "ok"; v: TaskCreated }>({ kind: "busy" });
  const [pending, setPending] = useState<"prepare" | "pause" | "resume" | "cancel" | "authorize" | "revoke" | null>(null);
  const [toast, setToast] = useToast();
  const [prep, setPrep] = useState<PrepareStepView | null>(null);
  useEffect(() => { void loadAssets().then((r) => setAssets(r.assets)); }, []);
  const load = useCallback(async () => {
    const r = await agentTasks.get(id).catch(() => null);
    if (!r || r.status === 0) return setState((s) => (s.kind === "ok" ? s : { kind: "nr", http: 0 }));
    if (notReady(r)) return setState({ kind: "nr", http: r.status });
    if (r.status !== 200) return setState({ kind: "err", msg: apiError(r, locale) });
    setState({ kind: "ok", v: r.data });
  }, [id, locale]);
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
  async function prepare() {
    setPending("prepare");
    const r = await agentTasks.prepareStep(id).catch(() => null);
    setPending(null);
    if (!r || r.status === 0) return setToast({ text: t("ag_service_unreachable"), tone: "bad" });
    if (notReady(r)) return setToast({ text: `${t("ag_not_ready_h")} · POST /v1/tasks/:id/prepare-step`, tone: "warn" });
    setPrep(r.data);
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
  return (
    <>
      <header>
        <div className="ag-actions"><h1 className="ag-h1 text-xl">{taskTitle(task, state.v.params, assets, locale)}</h1><Pill tone={TONE[task.status] ?? "neutral"}>{statusLabel(task.status, locale)}</Pill><ModeTag mode={mode} /></div>
        <p className="ag-lead">{steps ? `${t("ag_steps_done", { done: steps.confirmed, max: steps.planned })} · ` : ""}{zh ? "条件" : "conditions"} {task.conditions.items.length} · {zh ? "创建" : "created"} {formatTime(task.createdAt, locale)} · {zh ? "更新" : "updated"} {formatTime(task.updatedAt, locale)}</p>
      </header>
      <Card title={zh ? "动作" : "Actions"}>
        <div className="ag-actions">
          {mandateDraft && task.status === "AWAITING_AUTHORIZATION" && <button className="btn" disabled={pending !== null} onClick={() => authorize(mandateDraft)}>{pending === "authorize" ? t("wallet_connecting") : zh ? "签署授权（TradeMandate）" : "Sign the authorization (TradeMandate)"}</button>}
          {stoppable && <button className="btn-ghost" disabled={pending !== null} onClick={prepare}>{pending === "prepare" ? t("ag_evaluating") : t("ag_evaluate_now")}</button>}
          {stoppable && <button className="btn-ghost" disabled={pending !== null} onClick={() => stop("pause")}>{pending === "pause" ? t("ag_working") : t("task_pause")}</button>}
          {paused && <button className="btn-ghost" disabled={pending !== null} onClick={() => stop("resume")}>{pending === "resume" ? t("ag_working") : t("task_resume")}</button>}
          {(stoppable || paused) && <button className="btn-ghost" disabled={pending !== null} onClick={() => stop("cancel")}>{pending === "cancel" ? t("ag_working") : t("task_cancel")}</button>}
          {task.mandateIds.length > 0 && PLANGUARD_ADDRESS && <RevokeButton mandateId={task.mandateIds[task.mandateIds.length - 1]!} onRevoke={revoke} disabled={pending !== null} label={pending === "revoke" ? t("tx_pending") : t("task_revoke")} />}
        </div>
        {!sim && <p className="ag-warn mt-3">{t("ag_stop_note")}</p>}
      </Card>
      <div className="ag-grid-2">
        <Card title={zh ? "现在在等什么" : "What it is waiting for"}>
          <Blockers blockers={task.blockers} nextCheckAt={task.nextCheckAt} paused={paused} />
          <p className="mt-3 text-sm"><Link className="underline" href={`/agent/lab?taskId=${task.id}#wait`}>{t("ag_entry_wait")} →</Link> · <Link className="underline" href={`/agent/lab?taskId=${task.id}#compare`}>{t("ag_entry_compare")} →</Link></p>
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
      <Card title={`${t("ag_conditions")} · ${task.conditions.items.length}`}>
        <ul className="ag-list text-sm">{task.conditions.items.map((c, i) => <li key={i}>{conditionText(c, locale)}</li>)}</ul>
      </Card>
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
      <details className="card"><summary className="cursor-pointer text-sm">{zh ? "开发者视图（原始响应）" : "Developer view (raw response)"}</summary>
        <p className="mono mt-2 text-xs text-fg-3">{task.id} · {task.playbookId} · conditions {task.conditions.hash}</p>
        {prep !== null && <div className="mt-3"><p className="text-xs font-semibold uppercase tracking-wide text-fg-3">prepare-step</p><Json value={prep} /></div>}
        <Json value={state.v} />
      </details>
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
