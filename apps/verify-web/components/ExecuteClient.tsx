"use client";
/**
 * 执行确认页：连接钱包 → 切链 → 准备执行（再核验+证书）→ 精确 approve → 签 TradeIntent → 发 Guard 交易 → 回执 → 提交 hash。
 * 每步都有可恢复终态；不把"已广播"当成交；证书过期须重新准备。
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { encodeFunctionData, type Hex } from "viem";
import { api } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { reasonText } from "@/lib/reasons";
import { apiError } from "@/lib/errors";
import { Card, Json, Pill, Row, VerdictBadge } from "@/components/ui";
import { allowance, approveExact, balanceOf, CHAIN_ID, connect, currentChainId, ensureChain, EXPLORER, fmtUnits, sendGuardCall, short, signTypedData, waitReceipt } from "@/lib/wallet";
import { GUARD_ABI } from "@/lib/guardAbi";
import { execStateTone, type ExecutionReceipt, type JobView, type Report } from "@/components/JobClient";

interface Prepared {
  attemptId: string;
  state: string;
  reportVersion: number;
  report: Report | null;
  verdict: string | null;
  executionEligible: boolean;
  refreshesRemaining: number;
  entitlementExpiresAt: string | null;
  replay?: boolean;
  execution: {
    typedData: { domain: { name: string; version: string; chainId: number; verifyingContract: `0x${string}` }; types: Record<string, Array<{ name: string; type: string }>>; primaryType: "TradeIntent"; message: Record<string, string> };
    intentDigest: string;
    certificate: Record<string, string>;
    certificateSignature: `0x${string}`;
    attestationSigner: string;
    routerCalldata: `0x${string}`;
    approval: { token: `0x${string}`; spender: `0x${string}`; amount: string };
    guardCall: { to: `0x${string}` };
    validUntil: string | null;
    txHash: string | null;
    receipt: ExecutionReceipt | null;
  } | null;
  error?: string;
  message?: string;
  details?: unknown;
}

type Step = "idle" | "preparing" | "prepared" | "approving" | "approved" | "signing" | "signed" | "sending" | "pending" | "confirmed" | "reverted" | "expired" | "rejected_sign" | "error";

export function ExecuteClient({ jobId }: { jobId: string }) {
  const { t, locale } = useI18n();
  const [job, setJob] = useState<JobView | null>(null);
  const [account, setAccount] = useState<`0x${string}` | null>(null);
  const [chainOk, setChainOk] = useState(false);
  const [prep, setPrep] = useState<Prepared | null>(null);
  const [step, setStep] = useState<Step>("idle");
  const [msg, setMsg] = useState<string | null>(null);
  const [intentSig, setIntentSig] = useState<Hex | null>(null);
  const [txHash, setTxHash] = useState<Hex | null>(null);
  const [bal, setBal] = useState<{ token: bigint; allowance: bigint } | null>(null);
  const [now, setNow] = useState(Date.now());
  /** 服务端链上核实器的判定（SUBMITTED → REORG_PENDING → CONFIRMED / REVERTED / UNKNOWN）；客户端的回执只是提示 */
  const [serverExec, setServerExec] = useState<{ state: string; receipt: ExecutionReceipt | null } | null>(null);
  const [autoSend, setAutoSend] = useState(false);

  useEffect(() => {
    if (!txHash || !prep) return;
    let stopped = false;
    const tick = async () => {
      const r = await api<JobView>("GET", `v1/jobs/${jobId}`);
      if (stopped || r.status !== 200) return;
      const e = r.data.executions.find((x) => x.attemptId === prep.attemptId);
      if (e) setServerExec({ state: e.state, receipt: e.receipt });
      if (e && (e.state === "CONFIRMED" || e.state === "REVERTED")) stopped = true;
    };
    void tick();
    const id = setInterval(() => void tick(), 5000);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [txHash, prep, jobId]);

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    api<JobView>("GET", `v1/jobs/${jobId}`).then((r) => r.status === 200 && setJob(r.data));
  }, [jobId]);
  /** Guard 地址在 prepare 之前就要知道（先授权后核验：证书只有 ~30 s） */
  const [guardAddr, setGuardAddr] = useState<`0x${string}` | null>(null);
  useEffect(() => {
    api<{ guard?: string | null }>("GET", "healthz").then((r) => {
      if (r.status === 200 && r.data.guard && /^0x[0-9a-fA-F]{40}$/.test(r.data.guard)) setGuardAddr(r.data.guard as `0x${string}`);
    });
  }, []);

  const exec = prep?.execution ?? null;
  /** 授权目标：prepare 后以服务返回为准；prepare 前用任务金额 + Guard 地址 */
  const approvalTarget = useMemo(() => {
    if (exec) return exec.approval;
    if (!job || !guardAddr) return null;
    const token = job.job.inputAssetKey.split(":")[2];
    if (!token || !/^0x[0-9a-fA-F]{40}$/.test(token)) return null;
    return { token: token as `0x${string}`, spender: guardAddr, amount: job.job.amountInRaw };
  }, [exec, job, guardAddr]);
  const validUntilMs = exec?.validUntil ? Date.parse(exec.validUntil) : null;
  const secondsLeft = validUntilMs ? Math.max(0, Math.floor((validUntilMs - now) / 1000)) : null;
  useEffect(() => {
    if (secondsLeft === 0 && (step === "prepared" || step === "approved" || step === "signed")) setStep("expired");
  }, [secondsLeft, step]);

  const refreshBalances = useCallback(async () => {
    if (!account || !approvalTarget) return;
    const [tk, al] = await Promise.all([balanceOf(approvalTarget.token, account), allowance(approvalTarget.token, account, approvalTarget.spender)]);
    setBal({ token: tk, allowance: al });
  }, [account, approvalTarget]);
  useEffect(() => {
    void refreshBalances();
  }, [refreshBalances]);
  useEffect(() => {
    if (autoSend && step === "signed" && intentSig) {
      setAutoSend(false);
      void doSend();
    }
  }, [autoSend, step, intentSig]);

  async function doConnect() {
    setMsg(null);
    try {
      const a = await connect();
      setAccount(a);
      setChainOk((await currentChainId()) === CHAIN_ID);
    } catch (e) {
      setMsg(e instanceof Error && e.message === "no_wallet" ? t("no_wallet") : String(e));
    }
  }
  async function doSwitch() {
    try {
      await ensureChain();
      setChainOk((await currentChainId()) === CHAIN_ID);
    } catch (e) {
      setMsg(String(e));
    }
  }
  async function doPrepare() {
    setMsg(null);
    setStep("preparing");
    setIntentSig(null);
    setTxHash(null);
    const r = await api<Prepared>("POST", `v1/jobs/${jobId}/prepare-execution`, { refreshKey: `web-${Date.now()}` });
    setPrep(r.data);
    if (r.status === 200 && r.data.execution) setStep("prepared");
    else if (r.status === 422) setStep("error");
    else {
      setStep("error");
      setMsg(apiError(r, locale));
    }
  }
  async function doApprove() {
    if (!account || !approvalTarget) return;
    const before = step;
    setStep("approving");
    try {
      await approveExact(account, approvalTarget.token, approvalTarget.spender, BigInt(approvalTarget.amount));
      await refreshBalances();
      setStep(exec ? "approved" : "idle");
    } catch (e) {
      setStep(exec ? "prepared" : before === "approving" ? "idle" : before);
      setMsg((e as { code?: number }).code === 4001 ? t("rejected_sign") : String(e));
    }
  }
  /** 签名后立刻发送：证书窗口只有 ~30 s，少一次点击 */
  async function doSignAndSend() {
    await doSign();
  }
  async function doSign() {
    if (!account || !exec) return;
    setStep("signing");
    try {
      const m = exec.typedData.message;
      const sig = await signTypedData(account, exec.typedData.domain, { TradeIntent: exec.typedData.types["TradeIntent"]! }, "TradeIntent", {
        ...m,
        amountIn: BigInt(m["amountIn"]!),
        minAmountOut: BigInt(m["minAmountOut"]!),
        nonce: BigInt(m["nonce"]!),
        deadline: BigInt(m["deadline"]!),
      });
      setIntentSig(sig);
      setStep("signed");
      setAutoSend(true);
    } catch (e) {
      setStep("approved");
      setMsg((e as { code?: number }).code === 4001 ? t("rejected_sign") : String(e));
    }
  }
  async function doSend() {
    if (!account || !exec || !intentSig) return;
    setStep("sending");
    try {
      const m = exec.typedData.message;
      const c = exec.certificate;
      const data = encodeFunctionData({
        abi: GUARD_ABI,
        functionName: "execute",
        args: [
          { ...m, amountIn: BigInt(m["amountIn"]!), minAmountOut: BigInt(m["minAmountOut"]!), nonce: BigInt(m["nonce"]!), deadline: BigInt(m["deadline"]!) } as never,
          intentSig,
          { ...c, issuedAt: BigInt(c["issuedAt"]!), validUntil: BigInt(c["validUntil"]!), signerEpoch: BigInt(c["signerEpoch"]!) } as never,
          exec.certificateSignature,
          exec.routerCalldata,
        ],
      });
      const hash = await sendGuardCall(account, exec.guardCall.to, data, 900_000n);
      setTxHash(hash);
      setStep("pending");
      // 连同用户的 TradeIntent 签名一起回传：证据包靠它证明"证书的 intentDigest 对应一份 owner 亲签的意图"，
      // 不传则 /verify-bundle 的 cert_N_intent_digest 必为 ❌（服务端会验签，非 owner 签名 422）
      await api("POST", `v1/jobs/${jobId}/submissions`, { attemptId: prep!.attemptId, txHash: hash, intentSignature: intentSig });
      const rcpt = await waitReceipt(hash);
      setStep(rcpt.status === "success" ? "confirmed" : "reverted");
      await refreshBalances();
    } catch (e) {
      setStep((e as { code?: number }).code === 4001 ? "signed" : "error");
      setMsg((e as { code?: number }).code === 4001 ? t("rejected_sign") : String(e));
    }
  }

  const ownerOk = useMemo(() => !!account && !!job && account.toLowerCase() === job.job.ownerAddress.toLowerCase(), [account, job]);
  const inDec = 6;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">{t("exec_h")}</h1>
        {job && <Pill tone={job.evidenceMode === "LIVE" ? "ok" : "warn"}>{job.evidenceMode}</Pill>}
        <Link href={`/jobs/${jobId}`} className="btn-ghost ml-auto px-3 py-1 text-sm">{t("back_report")}</Link>
      </div>

      <Card title={locale === "zh" ? "钱包" : "Wallet"}>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          {account ? <span className="mono">{short(account)}</span> : <button className="btn" onClick={doConnect}>{t("connect")}</button>}
          {account && !chainOk && <button className="btn-ghost" onClick={doSwitch}>{t("switch_chain")}</button>}
          {account && chainOk && <Pill tone="ok">X Layer · {CHAIN_ID}</Pill>}
          {account && job && !ownerOk && <Pill tone="bad">{t("owner_mismatch")}</Pill>}
          {bal && exec && <span className="mono text-neutral-400">balance {fmtUnits(bal.token, inDec)} · allowance {fmtUnits(bal.allowance, inDec)}</span>}
        </div>
      </Card>

      <Card title={t("step_approve_first")}>
        <p className="mb-3 text-sm text-neutral-400">{t("approve_first_hint")}</p>
        <div className="flex flex-wrap items-center gap-3">
          {approvalTarget && bal && bal.allowance >= BigInt(approvalTarget.amount) ? (
            <Pill tone="ok">{t("approve_done")} · {fmtUnits(approvalTarget.amount, inDec)}</Pill>
          ) : (
            <button className="btn" disabled={!approvalTarget || !ownerOk || !chainOk || step === "approving"} onClick={doApprove}>
              {step === "approving" ? "…" : approvalTarget ? `approve ${fmtUnits(approvalTarget.amount, inDec)}` : "…"}
            </button>
          )}
          {bal && <span className="mono text-sm text-neutral-400">allowance {fmtUnits(bal.allowance, inDec)} · balance {fmtUnits(bal.token, inDec)}</span>}
        </div>
      </Card>

      <Card title={t("step_prepare_2")}>
        <div className="flex flex-wrap items-center gap-3">
          <button className="btn" disabled={step === "preparing" || !ownerOk || !chainOk} onClick={doPrepare}>
            {step === "preparing" ? t("running") : prep ? (locale === "zh" ? "再核验" : "Re-verify") : t("prepare_exec")}
          </button>
          {prep && <Pill>{t("refreshes_left")}: {prep.refreshesRemaining}</Pill>}
          {secondsLeft !== null && <Pill tone={secondsLeft > 15 ? "ok" : "bad"}>{t("valid_until")} {secondsLeft}s</Pill>}
        </div>
        {prep?.report && (
          <div className="mt-3 space-y-3">
            <VerdictBadge verdict={prep.report.verdict} />
            <ul className="space-y-1 text-sm">
              {prep.report.reasons.filter((r) => r.severity !== "info").map((r, i) => (
                <li key={i}>
                  <Pill tone={r.severity === "block" ? "bad" : "warn"}>{r.severity}</Pill> {reasonText(r.code, locale)} <span className="mono text-xs text-neutral-500">{r.code}</span>
                </li>
              ))}
            </ul>
            {!prep.execution && <p className="text-sm text-warn">{t("not_eligible")}</p>}
          </div>
        )}
        {prep?.error && <p className="mt-2 text-sm text-bad">{prep.error}: {prep.message} {prep.details ? JSON.stringify(prep.details) : ""}</p>}
      </Card>

      {exec && (
        <Card title={locale === "zh" ? "本次执行的硬边界（链上强制）" : "Hard bounds for this execution (enforced on-chain)"}>
          <Row k={t("max_spend")} v={`${fmtUnits(exec.typedData.message["amountIn"]!, inDec)} (${exec.typedData.message["amountIn"]})`} mono />
          <Row k={t("min_out")} v={`${fmtUnits(exec.typedData.message["minAmountOut"]!, 18, 8)} (${exec.typedData.message["minAmountOut"]})`} mono />
          <Row k={locale === "zh" ? "收款人" : "Recipient"} v={exec.typedData.message["recipient"]} mono />
          <Row k={locale === "zh" ? "路由 / 授权对象" : "Router / spender"} v={`${short(exec.typedData.message["router"]!)} / ${short(exec.typedData.message["spender"]!)}`} mono />
          <Row k="Guard" v={exec.guardCall.to} mono />
          <Row k={locale === "zh" ? "证明签发身份" : "Attestation signer"} v={exec.attestationSigner} mono />
          <Row k="nonce" v={exec.typedData.message["nonce"]} mono />
          <Row k="deadline" v={new Date(Number(exec.typedData.message["deadline"]) * 1000).toISOString()} mono />
        </Card>
      )}

      {exec && (
        <Card title={locale === "zh" ? "签名与发送" : "Sign & send"}>
          <ol className="space-y-3 text-sm">
            <li className="flex flex-wrap items-center gap-3">
              <span className="w-64">{t("step_approve")}</span>
              {bal && bal.allowance >= BigInt(exec.approval.amount) ? <Pill tone="ok">{t("approve_done")}</Pill> : (
                <button className="btn" disabled={!(step === "prepared" || step === "idle") || !ownerOk} onClick={doApprove}>{step === "approving" ? "…" : `approve ${fmtUnits(exec.approval.amount, inDec)}`}</button>
              )}
            </li>
            <li className="flex flex-wrap items-center gap-3">
              <span className="w-64">{t("step_sign_3")}</span>
              {intentSig ? <Pill tone="ok">signed</Pill> : (
                <button className="btn" disabled={!(step === "approved" || (bal && bal.allowance >= BigInt(exec.approval.amount) && step === "prepared"))} onClick={doSignAndSend}>{step === "signing" ? "…" : t("sign_and_send")}</button>
              )}
              {intentSig && step === "signed" && <button className="btn" onClick={doSend}>execute</button>}
              {step === "sending" && <Pill tone="warn">…</Pill>}
            </li>
            <li className="flex flex-wrap items-center gap-3">
              <span className="w-64">{t("step_receipt")}</span>
              {txHash && <a className="mono underline" href={`${EXPLORER}/tx/${txHash}`} target="_blank" rel="noreferrer">{short(txHash)}</a>}
              {step === "pending" && <Pill tone="warn">{t("tx_pending")}</Pill>}
              {step === "confirmed" && <Pill tone="ok">{t("tx_success")}</Pill>}
              {step === "reverted" && <Pill tone="bad">{t("tx_reverted")}</Pill>}
            </li>
            <li className="flex flex-wrap items-center gap-3">
              <span className="w-64">{t("step_server_receipt")}</span>
              {!txHash ? null : !serverExec ? <Pill tone="warn">…</Pill> : (
                <>
                  <Pill tone={execStateTone(serverExec.state)}>{serverExec.state}</Pill>
                  {serverExec.state === "REORG_PENDING" && serverExec.receipt && <span className="text-xs text-neutral-400">{serverExec.receipt.confirmations}/{serverExec.receipt.requiredConfirmations} conf</span>}
                  {serverExec.receipt?.event && <span className="mono text-xs text-neutral-400">spent {fmtUnits(serverExec.receipt.event.spent, inDec)} · received {serverExec.receipt.event.received} raw · refunded {fmtUnits(serverExec.receipt.event.refunded, inDec)}</span>}
                  {serverExec.state === "UNKNOWN" && serverExec.receipt?.reason && <span className="text-xs text-neutral-400">{serverExec.receipt.reason}</span>}
                </>
              )}
            </li>
          </ol>
          {step === "expired" && <p className="mt-3 text-sm text-warn">{t("expired")}</p>}
          {msg && <p className="mt-3 text-sm text-bad">{msg}</p>}
          <details className="demo-hide mt-3">
            <summary className="cursor-pointer text-xs text-neutral-400">{t("dev_details")}</summary>
            <Json value={{ typedData: exec.typedData, certificate: exec.certificate, certificateSignature: exec.certificateSignature, intentDigest: exec.intentDigest, routerCalldataHead: exec.routerCalldata.slice(0, 10) }} />
          </details>
        </Card>
      )}
    </div>
  );
}
