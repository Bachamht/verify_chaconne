"use client";
/** /tasks/[id]：授权计划进度、评估时间线（delta）、暂停/继续/取消、链上撤销、"我来执行这一步"、每步回执、账单、分享。 */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import type { Bill } from "@chaconne/core/verify";
import { mandates, type MandateView, type PreparedStep } from "@/lib/api-v2";
import { useI18n } from "@/lib/i18n";
import { reasonText } from "@/lib/reasons";
import { fmtLocal } from "@/lib/format";
import { apiError } from "@/lib/errors";
import { encodeExecuteStep, encodeRevoke } from "@/lib/mandate";
import { PLANGUARD_ADDRESS } from "@/lib/planGuardAbi";
import { Card, Pill, Row } from "@/components/ui";
import { allowance, approveExact, CHAIN_ID, connect, currentChainId, ensureChain, EXPLORER, fmtUnits, publicClient, sendGuardCall, short, waitReceipt } from "@/lib/wallet";
import { execStateTone } from "@/components/JobClient";
import { BillPanel } from "@/components/BillPanel";
import { ShareSettings } from "@/components/ShareSettings";

const STATE_TONE: Record<string, "ok" | "warn" | "bad" | "neutral"> = { ACTIVE: "ok", PAUSED: "warn", CANCELLED: "bad", REVOKED: "bad", COMPLETED: "ok", EXPIRED: "neutral", DRAFT: "neutral" };

export function TaskClient({ id }: { id: string }) {
  const { t, locale } = useI18n();
  const zh = locale === "zh";
  const [m, setM] = useState<MandateView | null>(null);
  const [status, setStatus] = useState<number | null>(null);
  const [bill, setBill] = useState<Bill | null>(null);
  const [account, setAccount] = useState<`0x${string}` | null>(null);
  const [prep, setPrep] = useState<PreparedStep | null>(null);
  const [phase, setPhase] = useState<"idle" | "preparing" | "approving" | "sending" | "pending" | "done" | "error">("idle");
  const [txHash, setTxHash] = useState<`0x${string}` | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  const load = useCallback(async () => {
    const r = await mandates.get(id);
    setStatus(r.status);
    if (r.status === 200) setM(r.data);
    const b = await mandates.bill(id);
    if (b.status === 200 && b.data) setBill(b.data);
  }, [id]);
  useEffect(() => {
    void load();
    const i = setInterval(() => void load(), 15000);
    const c = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(i);
      clearInterval(c);
    };
  }, [load]);

  async function wallet(): Promise<`0x${string}`> {
    const a = account ?? (await connect());
    setAccount(a);
    if ((await currentChainId()) !== CHAIN_ID) await ensureChain();
    return a;
  }
  async function action(kind: "pause" | "resume" | "cancel") {
    setMsg(null);
    const r = await mandates[kind](id);
    if (r.status === 200) setM(r.data);
    else setMsg(apiError(r, locale));
  }
  async function revoke() {
    if (!m) return;
    setMsg(null);
    try {
      const a = await wallet();
      const h = await sendGuardCall(a, PLANGUARD_ADDRESS as `0x${string}`, encodeRevoke(m.mandate));
      await waitReceipt(h);
      await action("cancel");
      setMsg(`${zh ? "已撤销" : "Revoked"} ${short(h)}`);
    } catch (e) {
      setMsg(String(e));
    }
  }
  async function executeStep() {
    if (!m) return;
    setMsg(null);
    setTxHash(null);
    try {
      // 步骤证书只有约 30 s（受报价时效约束）：授权必须在 prepare-step **之前**做完，否则证书在钱包弹窗里就过期了（I2 2026-09-21，服务器实测）
      const a = await wallet();
      if (a.toLowerCase() !== m.owner.toLowerCase()) {
        setPhase("error");
        return setMsg(t("owner_mismatch"));
      }
      const inputToken = m.mandate.inputToken as `0x${string}`;
      const remaining = BigInt(m.budgetCap) - BigInt(m.spent);
      const need = remaining < BigInt(m.perStepCap) ? remaining : BigInt(m.perStepCap);
      const planGuard = PLANGUARD_ADDRESS as `0x${string}`;
      const have = await allowance(inputToken, a, planGuard);
      if (need > 0n && have < need) {
        setPhase("approving");
        await approveExact(a, inputToken, planGuard, need);
      }
      setPhase("preparing");
      const r = await mandates.prepareStep(id);
      setPrep(r.data);
      if (r.status !== 200 || !r.data.step) {
        setPhase("idle");
        return;
      }
      const s = r.data.step;
      if (BigInt(s.approval.amount) > (await allowance(s.approval.token, a, s.approval.spender))) {
        setPhase("approving");
        await approveExact(a, s.approval.token, s.approval.spender, BigInt(s.approval.amount));
      }
      setPhase("sending");
      const data = encodeExecuteStep({ mandate: m.mandate, mandateSignature: m.signature, outputSet: s.outputSet, step: s.typedData.message, certificate: s.certificate, certificateSignature: s.certificateSignature, routerCalldata: s.routerCalldata });
      let gas = 900_000n;
      try {
        gas = ((await publicClient.estimateGas({ account: a, to: s.guardCall.to, data })) * 13n) / 10n;
      } catch (e) {
        setPhase("error");
        return setMsg(`executeStep would revert: ${e instanceof Error ? e.message.slice(0, 300) : String(e)}`);
      }
      const h = await sendGuardCall(a, s.guardCall.to, data, gas);
      setTxHash(h);
      setPhase("pending");
      await mandates.submit(id, s.stepIndex, h);
      const rcpt = await waitReceipt(h);
      setPhase(rcpt.status === "success" ? "done" : "error");
      if (rcpt.status !== "success") setMsg(t("tx_reverted"));
      await load();
    } catch (e) {
      setPhase("error");
      setMsg((e as { code?: number }).code === 4001 ? t("rejected_sign") : String(e));
    }
  }

  if (status && status !== 200) return <p className="text-bad">{status === 404 ? (zh ? "找不到任务，或它属于另一个钱包。" : "Task not found, or it belongs to another wallet.") : `Error ${status}`}</p>;
  if (!m) return <p className="text-neutral-400">{t("loading")}</p>;
  const inDec = 6;
  const pct = Number(m.budgetCap) > 0 ? Math.min(100, (Number(m.spent) / Number(m.budgetCap)) * 100) : 0;
  const latest = m.latestEvaluation;
  const secondsLeft = prep?.step?.validUntil ? Math.max(0, Math.floor((Date.parse(prep.step.validUntil) - now) / 1000)) : null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">{t("task_h")}</h1>
        <Pill tone={STATE_TONE[m.state] ?? "neutral"}>{m.state}</Pill>
        <Pill tone={m.evidenceMode === "LIVE" ? "ok" : "warn"}>{m.evidenceMode}</Pill>
        <Pill>{m.policyId} v{m.policyVersion}</Pill>
        <span className="mono ml-auto text-xs text-neutral-500">{m.mandateId}</span>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Card title={t("task_progress")}>
          <div className="mb-2 h-2 w-full overflow-hidden rounded bg-neutral-800"><div className="h-2 bg-brand" style={{ width: `${pct}%` }} /></div>
          <Row k={t("mandate_budget")} v={`${fmtUnits(m.spent, inDec)} / ${fmtUnits(m.budgetCap, inDec)}`} mono />
          <Row k={t("mandate_per_step")} v={fmtUnits(m.perStepCap, inDec)} mono />
          <Row k={t("task_steps")} v={`${m.stepsDone} / ${m.maxSteps}`} mono />
          <Row k={t("plan_deadline")} v={fmtLocal(Number(m.deadline), locale)} mono />
          <Row k="mandateDigest" v={m.mandateDigest} mono />
          <div className="mt-3 flex flex-wrap gap-2">
            {m.state === "ACTIVE" && <button className="btn-ghost px-3 py-1" onClick={() => action("pause")}>{t("task_pause")}</button>}
            {m.state === "PAUSED" && <button className="btn-ghost px-3 py-1" onClick={() => action("resume")}>{t("task_resume")}</button>}
            {(m.state === "ACTIVE" || m.state === "PAUSED") && <button className="btn-ghost px-3 py-1" onClick={() => action("cancel")}>{t("task_cancel")}</button>}
            {(m.state === "ACTIVE" || m.state === "PAUSED" || m.state === "CANCELLED") && PLANGUARD_ADDRESS && <button className="btn-ghost px-3 py-1 text-bad" onClick={revoke}>{t("task_revoke")}</button>}
          </div>
        </Card>
        <Card title={t("task_exec_step")}>
          {latest ? (
            <div className="mb-3 text-sm">
              <Pill tone={latest.status === "READY" ? "ok" : latest.status === "BLOCKED" ? "bad" : "warn"}>{latest.status}</Pill> <span className="text-neutral-400">{fmtLocal(latest.evaluatedAt, locale)}</span>
              {latest.delta && <p className="mt-1 text-neutral-300">{zh ? latest.delta.summary.zh : latest.delta.summary.en}</p>}
            </div>
          ) : (
            <p className="mb-3 text-sm text-neutral-400">{t("task_wait")}</p>
          )}
          <button className="btn" disabled={m.state !== "ACTIVE" || phase === "preparing" || phase === "approving" || phase === "sending" || phase === "pending"} onClick={executeStep}>
            {phase === "preparing" ? t("running") : phase === "approving" ? `approve…` : phase === "sending" ? "execute…" : phase === "pending" ? t("tx_pending") : t("task_exec_step")}
          </button>
          {prep && !prep.step && <p className="mt-2 text-sm text-neutral-300">{t("task_wait")} {(prep.reasons ?? []).map((r) => reasonText(r.code, locale)).join("; ")}</p>}
          {prep?.step && (
            <div className="mt-3 text-sm">
              <Row k="stepIndex" v={prep.step.stepIndex} mono />
              <Row k="amountIn" v={prep.step.typedData.message.amountIn} mono />
              <Row k={t("min_out")} v={prep.step.typedData.message.minAmountOut} mono />
              <Row k="outputToken" v={short(prep.step.typedData.message.outputToken)} mono />
              <Row k={t("valid_until")} v={`${fmtLocal(prep.step.validUntil, locale)}${secondsLeft !== null ? ` (${secondsLeft}s)` : ""}`} mono />
              <Row k="stepDigest" v={prep.step.stepDigest} mono />
            </div>
          )}
          {txHash && <p className="mono mt-2 text-xs"><a className="underline" href={`${EXPLORER}/tx/${txHash}`} target="_blank" rel="noreferrer">{short(txHash)}</a> {phase === "done" && <Pill tone="ok">{t("tx_success")}</Pill>}</p>}
          {msg && <p className="mt-2 text-sm text-bad">{msg}</p>}
        </Card>
      </div>

      <Card title={t("task_timeline")}>
        <ul className="space-y-2 text-sm">
          {m.evaluations.length === 0 && <li className="text-neutral-400">—</li>}
          {m.evaluations.map((e) => (
            <li key={e.evaluationId} className="flex flex-wrap gap-2 border-b border-neutral-800 py-1 last:border-0">
              <span className="mono text-xs text-neutral-500">{fmtLocal(e.evaluatedAt, locale)}</span>
              <Pill tone={e.status === "READY" ? "ok" : e.status === "BLOCKED" ? "bad" : e.status === "DONE" ? "ok" : "warn"}>{e.status}</Pill>
              <span className="text-neutral-300">{e.delta ? (zh ? e.delta.summary.zh : e.delta.summary.en) : e.reasons.filter((r) => r.severity !== "info").map((r) => reasonText(r.code, locale)).join("; ") || "—"}</span>
              {e.preparedStepIndex !== null && <Pill>step {e.preparedStepIndex}</Pill>}
            </li>
          ))}
        </ul>
      </Card>

      <Card title={t("task_steps")}>
        <ul className="space-y-2 text-sm">
          {m.steps.length === 0 && <li className="text-neutral-400">—</li>}
          {m.steps.map((s) => (
            <li key={s.stepIndex} className="flex flex-wrap items-center gap-2 border-b border-neutral-800 py-1 last:border-0">
              <span className="mono">#{s.stepIndex}</span>
              <Pill tone={execStateTone(s.state)}>{s.state}</Pill>
              {s.step && <span className="mono text-xs text-neutral-400">{s.step.amountIn} → ≥{s.step.minAmountOut} {short(s.step.outputToken)}</span>}
              {s.txHash && <a className="mono underline" href={`${EXPLORER}/tx/${s.txHash}`} target="_blank" rel="noreferrer">{short(s.txHash)}</a>}
              {s.receipt && typeof s.receipt["event"] === "object" && s.receipt["event"] !== null && (
                <span className="mono text-xs text-neutral-400">{t("receipt_verified")} · spent {(s.receipt["event"] as { spent?: string }).spent} · received {(s.receipt["event"] as { received?: string }).received} · refunded {(s.receipt["event"] as { refunded?: string }).refunded}</span>
              )}
            </li>
          ))}
        </ul>
      </Card>

      <div className="grid gap-4 md:grid-cols-2">
        <BillPanel bill={bill} />
        <ShareSettings kind="mandate" refId={m.mandateId} />
      </div>
      <div className="flex flex-wrap gap-2">
        <Link href={`/verify-bundle?mandate=${m.mandateId}`} className="btn-ghost">{t("nav_verify_bundle")}</Link>
        {m.planId && <Link href={`/plan?plan=${m.planId}`} className="btn-ghost">← plan</Link>}
      </div>
    </div>
  );
}
