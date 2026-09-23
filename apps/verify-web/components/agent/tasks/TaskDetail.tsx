"use client";
/**
 * /agent/tasks/[id]：阻塞项全量、nextCheckAt、执行器三态文案、授权（签 TradeMandate 草案）、prepare-step、
 * 停止按钮（D-088 说明：只阻止后续签发，已取走的证书仍可能可执行，彻底停止以链上撤销确认为准）。
 */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { agentTasks, mandates, notReady, type MandateDraftView, type TaskCreated } from "@/lib/api-v2";
import { apiError } from "@/lib/errors";
import { fmtLocal } from "@/lib/format";
import { CHAIN_ID, connect, currentChainId, ensureChain, sendGuardCall, signTypedData, waitReceipt } from "@/lib/wallet";
import { encodeRevoke } from "@/lib/mandate";
import { PLANGUARD_ADDRESS } from "@/lib/planGuardAbi";
import { useAccount } from "@/lib/useAccount";
import type { TradeMandate } from "@chaconne/core/verify";
import { Card, Json, Pill } from "@/components/ui";
import { Blockers } from "../home/EntryForms";
import { ModeTag, NotReady } from "../shared";

export function TaskDetail({ id }: { id: string }) {
  const { locale, t } = useI18n();
  const zh = locale === "zh";
  const account = useAccount();
  const [state, setState] = useState<{ kind: "busy" } | { kind: "nr"; http: number } | { kind: "err"; msg: string } | { kind: "ok"; v: TaskCreated }>({ kind: "busy" });
  const [msg, setMsg] = useState<string | null>(null);
  const [prep, setPrep] = useState<unknown>(null);
  const load = useCallback(async () => {
    const r = await agentTasks.get(id).catch(() => null);
    if (!r) return setState({ kind: "nr", http: 0 });
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
    setMsg(null);
    const r = await agentTasks[kind](id).catch(() => null);
    if (!r) return setMsg(zh ? "服务不可达" : "Service unreachable");
    if (r.status !== 200) return setMsg(apiError(r, locale));
    setMsg(r.data.note || t("ag_stop_note"));
    void load();
  }
  async function authorize(draft: MandateDraftView) {
    setMsg(null);
    try {
      const a = await wallet();
      if (a.toLowerCase() !== draft.typedData.message.owner.toLowerCase()) return setMsg(zh ? "已连接钱包不是这份授权的 owner" : "Connected wallet is not this mandate's owner");
      const m = draft.typedData.message;
      const big = { ...m, budgetCap: BigInt(m.budgetCap), perStepCap: BigInt(m.perStepCap), maxSteps: Number(m.maxSteps), validFrom: BigInt(m.validFrom), deadline: BigInt(m.deadline), nonce: BigInt(m.nonce) };
      const sig = await signTypedData(a, draft.typedData.domain, draft.typedData.types, "TradeMandate", big as unknown as Record<string, unknown>);
      const r = await agentTasks.authorize(id, { typedData: draft.typedData, signature: sig, outputSet: draft.outputSet, clientRequestId: `web-auth-${id}` });
      if (r.status !== 201 && r.status !== 200) return setMsg(apiError(r, locale));
      setMsg(zh ? "授权已登记；执行由你的钱包或 Agent 完成。" : "Authorization registered; execution is done by your wallet or agent.");
      void load();
    } catch (e) {
      setMsg(String(e));
    }
  }
  async function revoke(mandate: TradeMandate) {
    setMsg(null);
    try {
      const a = await wallet();
      const h = await sendGuardCall(a, PLANGUARD_ADDRESS as `0x${string}`, encodeRevoke(mandate));
      await waitReceipt(h);
      setMsg(`${zh ? "链上已撤销" : "Revoked on-chain"} ${h.slice(0, 10)}…`);
      void load();
    } catch (e) {
      setMsg(String(e));
    }
  }
  async function prepare() {
    setMsg(null);
    const r = await agentTasks.prepareStep(id).catch(() => null);
    if (!r) return setMsg(zh ? "服务不可达" : "Service unreachable");
    if (notReady(r)) return setMsg(`${t("ag_not_ready_h")} · POST /v1/tasks/:id/prepare-step`);
    setPrep(r.data);
    void load();
  }

  if (state.kind === "busy") return <p className="ag-note">{t("ag_loading")}</p>;
  if (state.kind === "nr") return <NotReady what={`GET /v1/tasks/${id}`} status={state.http} compact={false} />;
  if (state.kind === "err") return <Card><p className="text-sm text-bad">{state.msg}</p><Link className="mt-2 inline-block text-sm underline" href="/agent/tasks">{zh ? "← 返回任务列表" : "← Back to tasks"}</Link></Card>;
  const { task, mandateDraft, thesisDraft, budgetAllocation } = state.v;
  const presence = task.executorPresence === "online" ? t("ag_exec_online") : task.executorPresence === "awaiting_signature" ? t("ag_exec_awaiting") : t("ag_exec_offline");
  const stoppable = ["ACTIVE", "WAITING", "STEP_PREPARED", "PARTIAL"].includes(task.status);
  const mode = mandateDraft || task.mandateIds.length ? "LIVE" : "SIMULATION";
  return (
    <>
      <header>
        <div className="ag-actions"><h1 className="ag-h1 mono text-xl">{task.id}</h1><Pill tone="neutral">{task.status}</Pill><ModeTag mode={mode} /></div>
        <p className="ag-lead">{task.playbookId} · {zh ? "条件" : "conditions"} {task.conditions.items.length} · <span className="mono text-[11px]">{task.conditions.hash.slice(0, 18)}…</span></p>
      </header>
      <div className="ag-grid-2">
        <Card title={zh ? "现在在等什么" : "What it is waiting for"}>
          <Blockers blockers={task.blockers} nextCheckAt={task.nextCheckAt} labelAll={t("ag_blockers")} labelNone={t("ag_no_blockers")} labelNext={t("ag_next_check")} />
          <p className="mt-3 text-sm"><Link className="underline" href={`/agent?entry=wait&task=${task.id}`}>{t("ag_entry_wait")} →</Link> · <Link className="underline" href={`/agent?entry=compare&task=${task.id}`}>{t("ag_entry_compare")} →</Link></p>
        </Card>
        <Card title={zh ? "执行器" : "Executor"}>
          <div className="ag-actions"><Pill tone={task.executorPresence === "online" ? "ok" : task.executorPresence === "awaiting_signature" ? "info" : "neutral"}>{task.executorPresence}</Pill></div>
          <p className="ag-note mt-2">{presence}</p>
          <p className="ag-note">{zh ? "执行器状态是信息项，不阻塞签发。" : "Presence is informational; it never blocks issuance."}</p>
          <dl className="ag-kv mt-3"><dt>{zh ? "授权" : "authorizations"}</dt><dd>{task.mandateIds.length ? task.mandateIds.map((m) => <Link key={m} className="mono underline" href={`/tasks/${m}`}>{m} </Link>) : "—"}</dd><dt>{zh ? "创建" : "created"}</dt><dd className="mono">{fmtLocal(task.createdAt, locale)}</dd><dt>{zh ? "更新" : "updated"}</dt><dd className="mono">{fmtLocal(task.updatedAt, locale)}</dd>{task.budgetGroupId && <><dt>{zh ? "资金组" : "budget group"}</dt><dd><Link className="mono underline" href={`/agent/funds?group=${task.budgetGroupId}`}>{task.budgetGroupId}</Link></dd></>}{budgetAllocation && <><dt>{zh ? "预留" : "allocation"}</dt><dd className="mono">{budgetAllocation.state}{budgetAllocation.reservedRaw ? ` · ${budgetAllocation.reservedRaw}` : ""}</dd></>}</dl>
        </Card>
      </div>
      <Card title={zh ? "动作" : "Actions"}>
        <div className="ag-actions">
          {mandateDraft && task.status === "AWAITING_AUTHORIZATION" && <button className="btn" onClick={() => authorize(mandateDraft)}>{zh ? "签署授权（TradeMandate）" : "Sign the authorization (TradeMandate)"}</button>}
          {stoppable && <button className="btn-ghost" onClick={prepare}>{zh ? "现在评估一次（prepare-step）" : "Evaluate now (prepare-step)"}</button>}
          {stoppable && <button className="btn-ghost" onClick={() => stop("pause")}>{t("task_pause")}</button>}
          {task.status === "PAUSED" && <button className="btn-ghost" onClick={() => stop("resume")}>{t("task_resume")}</button>}
          {(stoppable || task.status === "PAUSED") && <button className="btn-ghost" onClick={() => stop("cancel")}>{t("task_cancel")}</button>}
          {task.mandateIds.length > 0 && PLANGUARD_ADDRESS && <RevokeButton mandateId={task.mandateIds[task.mandateIds.length - 1]!} onRevoke={revoke} label={t("task_revoke")} />}
        </div>
        <p className="ag-warn mt-3">{t("ag_stop_note")}</p>
        {msg && <p className="mt-2 text-sm">{msg}</p>}
        {prep !== null && <div className="mt-3"><p className="text-xs font-semibold uppercase tracking-wide text-fg-3">prepare-step</p><Json value={prep} /></div>}
      </Card>
      {thesisDraft && <Card title={zh ? "理由卡草案" : "Thesis draft"}><p className="text-sm">{thesisDraft.goal}</p><p className="ag-note">{thesisDraft.rationale}</p><ul className="ag-list mt-2 text-xs">{thesisDraft.premises.map((p) => <li key={p.id}><Pill tone={p.status === "holds" ? "ok" : p.status === "invalidated" ? "bad" : "neutral"}>{p.kind} · {p.status}</Pill> {p.text}</li>)}</ul><p className="ag-note mt-2">{zh ? "到期" : "valid until"} {fmtLocal(thesisDraft.validUntil, locale)} · onInvalidation: {thesisDraft.onInvalidation}</p></Card>}
      <details className="card"><summary className="cursor-pointer text-sm">{zh ? "开发者视图（原始响应）" : "Developer view (raw response)"}</summary><Json value={state.v} /></details>
    </>
  );
}

/** 链上撤销需要 mandate 原文：从 v5 授权接口读 */
function RevokeButton({ mandateId, onRevoke, label }: { mandateId: string; onRevoke: (m: TradeMandate) => void; label: string }) {
  const [m, setM] = useState<TradeMandate | null>(null);
  useEffect(() => {
    mandates.get(mandateId).then((r) => { if (r.status === 200 && r.data.mandate) setM(r.data.mandate); }).catch(() => undefined);
  }, [mandateId]);
  if (!m) return null;
  return <button className="btn-ghost text-bad" onClick={() => onRevoke(m)}>{label}</button>;
}
