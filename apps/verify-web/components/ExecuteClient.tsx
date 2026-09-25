"use client";
/**
 * 执行确认页：连接钱包 → 切链 → 精确 approve → 准备执行（再核验+证书）→ 签 TradeIntent → 发 Guard 交易 → 回执 → 提交 hash。
 * 每步都有可恢复终态；不把"已广播"当成交；证书过期须重新准备。
 *
 * V-36：钱包状态与页头共用 useAccount（刷新用 eth_accounts 静默恢复）；四种状态（连接中 / 等待签名 / 证明过期 / 账户不对）
 * 都在钱包卡上；每个钱包请求有 60 s「没看到弹窗？」提示、5 min 超时与取消；非 owner 账户所有会签名/发交易的按钮真的禁用并说明原因。
 * V-37：数量一律人类单位 + 符号；时间本地化；不出现原始单位。
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { encodeFunctionData, type Hex } from "viem";
import { api, type AssetsResponse } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { tx, walletErrorText } from "@/lib/i18n.execute";
import { reasonText } from "@/lib/reasons";
import { apiError } from "@/lib/errors";
import { fmtLocal } from "@/lib/format";
import { assetMeta, fmtAmount } from "@/lib/format.execute";
import { Card, Pill, Row, VerdictBadge } from "@/components/ui";
import { activeWalletName, allowance, approveExact, balanceOf, CHAIN_ID, connect, currentChainId, ensureChain, EXPLORER, forgetWallet, injected, restoreConnection, sendGuardCall, short, signTypedData, waitReceipt } from "@/lib/wallet";
import { useAccount } from "@/lib/useAccount";
import { useWalletStatus } from "@/lib/useWalletStatus";
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
type Evented = { on?: (ev: string, fn: (x: unknown) => void) => void; removeListener?: (ev: string, fn: (x: unknown) => void) => void };

export function ExecuteClient({ jobId }: { jobId: string }) {
  const { t, locale } = useI18n();
  const [job, setJob] = useState<JobView | null>(null);
  const [assets, setAssets] = useState<AssetsResponse["assets"] | null>(null);
  /** 与页头同源（eth_accounts）；刷新后静默恢复 */
  const connectedRaw = useAccount();
  const account = useMemo(() => (connectedRaw && /^0x[0-9a-fA-F]{40}$/.test(connectedRaw) ? (connectedRaw as `0x${string}`) : null), [connectedRaw]);
  const [restored, setRestored] = useState(false);
  const [chainId, setChainId] = useState<number | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [switching, setSwitching] = useState(false);
  const wstatus = useWalletStatus();
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
    api<AssetsResponse>("GET", "v1/assets").then((r) => r.status === 200 && Array.isArray(r.data?.assets) && setAssets(r.data.assets)).catch(() => undefined);
  }, [jobId]);
  /** 挂载：静默恢复（eth_accounts，不弹窗），之后才决定显示「连接钱包」还是地址 */
  useEffect(() => {
    let alive = true;
    restoreConnection().finally(() => alive && setRestored(true));
    return () => { alive = false; };
  }, []);
  /** 链 id：账户变化后读一次，并订阅 chainChanged（切链后钱包会广播） */
  useEffect(() => {
    if (!account) {
      setChainId(null);
      return;
    }
    let alive = true;
    const read = () => currentChainId().then((c) => alive && setChainId(c)).catch(() => alive && setChainId(null));
    read();
    const eth = injected() as unknown as Evented | null;
    const onChain = (hex: unknown) => alive && setChainId(typeof hex === "string" ? Number.parseInt(hex, 16) : null);
    eth?.on?.("chainChanged", onChain);
    return () => {
      alive = false;
      eth?.removeListener?.("chainChanged", onChain);
    };
  }, [account, wstatus.status]);
  /** Guard 地址在 prepare 之前就要知道（先授权后核验：证书只有 ~30 s） */
  const [guardAddr, setGuardAddr] = useState<`0x${string}` | null>(null);
  useEffect(() => {
    api<{ guard?: string | null }>("GET", "healthz").then((r) => {
      if (r.status === 200 && r.data.guard && /^0x[0-9a-fA-F]{40}$/.test(r.data.guard)) setGuardAddr(r.data.guard as `0x${string}`);
    });
  }, []);

  const exec = prep?.execution ?? null;
  const chainOk = chainId === CHAIN_ID;
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
    if (!account || !approvalTarget) {
      setBal(null);
      return;
    }
    try {
      const [tk, al] = await Promise.all([balanceOf(approvalTarget.token, account), allowance(approvalTarget.token, account, approvalTarget.spender)]);
      setBal({ token: tk, allowance: al });
    } catch {
      setBal(null);
    }
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

  const ownerOk = useMemo(() => !!account && !!job && account.toLowerCase() === job.job.ownerAddress.toLowerCase(), [account, job]);
  const inMeta = assetMeta(assets, job?.job.inputAssetKey ?? "", "stable_input");
  const outMeta = assetMeta(assets, job?.job.outputAssetKey ?? "", "stock_output");
  const inAmt = (raw: string | bigint | null | undefined, approx = false) => fmtAmount(raw, inMeta.decimals, inMeta.symbol, { approx });
  const outAmt = (raw: string | bigint | null | undefined, approx = false) => fmtAmount(raw, outMeta.decimals, outMeta.symbol, { approx });
  const walletBusy = wstatus.status !== "idle";
  const walletName = wstatus.walletName ?? activeWalletName();
  const awaitingSignature = walletBusy && (wstatus.phase === "approve" || wstatus.phase === "sign" || wstatus.phase === "send");

  async function doConnect() {
    // 首击即有反馈：立刻进入 connecting（按钮禁用 + 文案）；discovery 未完成时 connect() 内部等 announce，点击不会丢
    if (connecting) return;
    setMsg(null);
    setConnecting(true);
    try {
      await connect();
    } catch (e) {
      setMsg(walletErrorText(e, locale));
    } finally {
      setConnecting(false);
    }
  }
  async function doChangeWallet() {
    setMsg(null);
    forgetWallet();
    setBal(null);
    setConnecting(true);
    try {
      await connect({ force: true });
    } catch (e) {
      setMsg(walletErrorText(e, locale));
    } finally {
      setConnecting(false);
    }
  }
  async function doSwitch() {
    setMsg(null);
    setSwitching(true);
    try {
      await ensureChain();
      setChainId(await currentChainId());
    } catch (e) {
      setMsg(walletErrorText(e, locale));
    } finally {
      setSwitching(false);
    }
  }
  async function doPrepare() {
    if (!ownerOk) return;
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
    if (!account || !approvalTarget || !ownerOk || !chainOk) return;
    setMsg(null);
    setStep("approving");
    try {
      await approveExact(account, approvalTarget.token, approvalTarget.spender, BigInt(approvalTarget.amount));
      await refreshBalances();
      setStep(exec ? "approved" : "idle");
    } catch (e) {
      setStep(exec ? "prepared" : "idle");
      setMsg(walletErrorText(e, locale));
    }
  }
  /** 签名后立刻发送：证书窗口只有 ~30 s，少一次点击 */
  async function doSignAndSend() {
    await doSign();
  }
  async function doSign() {
    if (!account || !exec || !ownerOk || !chainOk) return;
    setMsg(null);
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
      setMsg(walletErrorText(e, locale));
    }
  }
  async function doSend() {
    if (!account || !exec || !intentSig || !ownerOk) return;
    setMsg(null);
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
      const kind = (e as { kind?: string }).kind;
      setStep(kind === "rejected" || kind === "cancelled" || kind === "wrong_chain" ? "signed" : "error");
      setMsg(walletErrorText(e, locale));
    }
  }

  /** 会签名 / 发交易的按钮为什么不可点（V-36：非 owner 真的禁用，并说原因） */
  const gate: string | null = !account ? tx(locale, "disabled_no_wallet") : !ownerOk ? tx(locale, "disabled_not_owner") : !chainOk ? tx(locale, "disabled_wrong_chain") : walletBusy ? tx(locale, "disabled_busy") : null;
  const approved = !!approvalTarget && !!bal && bal.allowance >= BigInt(approvalTarget.amount);
  const confirmLine = walletName ? tx(locale, "wallet_confirm_in", { wallet: walletName }) : tx(locale, "wallet_confirm_generic");

  /* ---- 钱包卡的四种状态 ---- */
  const walletState: "restoring" | "disconnected" | "connecting" | "awaiting" | "wrong_account" | "cert_expired" | "connected" =
    !restored && !account ? "restoring"
      : connecting || (walletBusy && wstatus.phase === "connect") ? "connecting"
        : !account ? "disconnected"
          : awaitingSignature ? "awaiting"
            : job && !ownerOk ? "wrong_account"
              : step === "expired" || (exec && secondsLeft === 0) ? "cert_expired"
                : "connected";

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">{t("exec_h")}</h1>
        {job && <Pill tone={job.evidenceMode === "LIVE" ? "ok" : "warn"}>{job.evidenceMode}</Pill>}
        <Link href={`/jobs/${jobId}`} className="btn-ghost ml-auto px-3 py-1 text-sm">{t("back_report")}</Link>
      </div>

      <Card title={tx(locale, "wallet_card")} right={
        <Pill tone={walletState === "connected" ? "ok" : walletState === "wrong_account" || walletState === "cert_expired" ? "bad" : walletState === "disconnected" || walletState === "restoring" ? "neutral" : "warn"}>
          {walletState === "restoring" ? "…" : walletState === "disconnected" ? t("connect") : walletState === "connecting" ? tx(locale, "wallet_state_connecting") : walletState === "awaiting" ? tx(locale, "wallet_state_awaiting") : walletState === "wrong_account" ? tx(locale, "wallet_state_wrong_account") : walletState === "cert_expired" ? tx(locale, "wallet_state_cert_expired") : tx(locale, "wallet_state_connected")}
        </Pill>
      }>
        <div className="space-y-2 text-sm">
          {walletState === "restoring" && <p className="text-fg-2">{tx(locale, "wallet_restoring")}</p>}
          {walletState === "disconnected" && (
            <div className="flex flex-wrap items-center gap-3">
              <button className="btn" onClick={doConnect} aria-busy={connecting}>{t("connect")}</button>
              <button className="btn-ghost px-3 py-1 text-xs" onClick={doChangeWallet} title={tx(locale, "wallet_change_hint")}>{tx(locale, "wallet_change")}</button>
            </div>
          )}
          {walletState === "connecting" && (
            <div className="flex flex-wrap items-center gap-3">
              <button className="btn" disabled aria-busy="true">{t("wallet_connecting")}</button>
              <span className="text-fg-2">{confirmLine}</span>
            </div>
          )}
          {account && walletState !== "connecting" && (
            <div className="flex flex-wrap items-center gap-3">
              <span className="mono" title={account}>{short(account)}</span>
              {walletName && <span className="text-xs text-fg-3">{walletName}</span>}
              {chainOk ? <Pill tone="ok">X Layer · {CHAIN_ID}</Pill> : (
                <button className="btn-ghost px-3 py-1 text-xs" onClick={doSwitch} disabled={switching || walletBusy} aria-busy={switching}>{switching ? `${t("switch_chain")}…` : t("switch_chain")}</button>
              )}
              <button className="btn-ghost px-3 py-1 text-xs" onClick={doChangeWallet} disabled={walletBusy} title={tx(locale, "wallet_change_hint")}>{tx(locale, "wallet_change")}</button>
              {bal && approvalTarget && <span className="mono text-xs text-fg-2">{tx(locale, "balance_line", { balance: inAmt(bal.token), allowance: inAmt(bal.allowance) })}</span>}
            </div>
          )}
          {walletState === "wrong_account" && job && (
            <p className="text-bad">{t("owner_mismatch")} {tx(locale, "wallet_owner_needed", { owner: short(job.job.ownerAddress) })}</p>
          )}
          {walletState === "awaiting" && (
            <p className="text-warn">
              <span className="mono mr-2 text-xs">{wstatus.phase ? tx(locale, `phase_${wstatus.phase}` as "phase_approve") : ""}</span>
              {confirmLine}
            </p>
          )}
          {walletBusy && wstatus.status === "slow" && (
            <div className="space-y-1 rounded-md border border-warn/40 bg-warn/10 px-3 py-2">
              <p className="text-warn">{tx(locale, "wallet_no_popup")}</p>
              <div className="flex flex-wrap gap-2">
                {wstatus.cancel && <button className="btn-ghost px-3 py-1 text-xs" onClick={() => wstatus.cancel?.()}>{tx(locale, "wallet_cancel_wait")}</button>}
                <button className="btn-ghost px-3 py-1 text-xs" onClick={() => { wstatus.cancel?.(); void doChangeWallet(); }}>{tx(locale, "wallet_change")}</button>
              </div>
              <p className="text-xs text-fg-3">{tx(locale, "wallet_cancel_note")}</p>
            </div>
          )}
          {exec && secondsLeft !== null && (
            <p className={secondsLeft === 0 ? "text-bad" : secondsLeft > 15 ? "text-ok" : "text-warn"}>
              {secondsLeft === 0 ? tx(locale, "cert_expired_reverify") : tx(locale, "wallet_state_cert_valid", { s: secondsLeft })}
            </p>
          )}
        </div>
      </Card>
      {msg && <p className="rounded-md border border-bad/40 bg-bad/10 px-3 py-2 text-sm text-bad" role="alert">{msg}</p>}

      <Card title={t("step_approve_first")}>
        <p className="mb-3 text-sm text-fg-2">{t("approve_first_hint")}</p>
        <div className="flex flex-wrap items-center gap-3">
          {approved && approvalTarget ? (
            <Pill tone="ok">{t("approve_done")} · {inAmt(approvalTarget.amount)}</Pill>
          ) : (
            <button className="btn" disabled={!approvalTarget || !!gate || step === "approving"} onClick={doApprove} aria-busy={step === "approving"}>
              {step === "approving" ? (walletBusy ? tx(locale, "approve_pending") : tx(locale, "approve_mining")) : approvalTarget ? tx(locale, "approve_btn", { amount: inAmt(approvalTarget.amount) }) : t("loading")}
            </button>
          )}
          {bal && <span className="mono text-sm text-fg-2">{tx(locale, "balance_line", { balance: inAmt(bal.token), allowance: inAmt(bal.allowance) })}</span>}
        </div>
        {!approved && gate && <p className="mt-2 text-xs text-fg-2">{gate}</p>}
      </Card>

      <Card title={t("step_prepare_2")}>
        <div className="flex flex-wrap items-center gap-3">
          <button className="btn" disabled={step === "preparing" || !!gate} onClick={doPrepare} aria-busy={step === "preparing"}>
            {step === "preparing" ? t("running") : prep ? tx(locale, "reverify") : t("prepare_exec")}
          </button>
          {prep && <Pill>{t("refreshes_left")}: {prep.refreshesRemaining}</Pill>}
          {secondsLeft !== null && <Pill tone={secondsLeft === 0 ? "bad" : secondsLeft > 15 ? "ok" : "warn"}>{secondsLeft === 0 ? tx(locale, "wallet_state_cert_expired") : tx(locale, "cert_countdown", { s: secondsLeft })}</Pill>}
        </div>
        {gate && <p className="mt-2 text-xs text-fg-2">{gate}</p>}
        {prep?.report && (
          <div className="mt-3 space-y-3">
            <VerdictBadge verdict={prep.report.verdict} />
            <ul className="space-y-1 text-sm">
              {prep.report.reasons.filter((r) => r.severity !== "info").map((r, i) => (
                <li key={i}>
                  <Pill tone={r.severity === "block" ? "bad" : "warn"}>{r.severity}</Pill> {reasonText(r.code, locale)} <span className="mono text-xs text-fg-3">{r.code}</span>
                </li>
              ))}
            </ul>
            {!prep.execution && <p className="text-sm text-warn">{t("not_eligible")}</p>}
          </div>
        )}
        {prep?.error && !prep.report && <p className="mt-2 text-sm text-bad">{apiError({ status: 422, data: prep }, locale)}</p>}
      </Card>

      {exec && (
        <Card title={tx(locale, "hard_bounds")}>
          <Row k={t("max_spend")} v={inAmt(exec.typedData.message["amountIn"]!)} mono />
          <Row k={t("min_out")} v={outAmt(exec.typedData.message["minAmountOut"]!)} mono />
          <Row k={tx(locale, "recipient")} v={exec.typedData.message["recipient"]} mono />
          <Row k={tx(locale, "router_spender")} v={`${short(exec.typedData.message["router"]!)} / ${short(exec.typedData.message["spender"]!)}`} mono />
          <Row k="Guard" v={exec.guardCall.to} mono />
          <Row k={tx(locale, "attestation_signer")} v={exec.attestationSigner} mono />
          <Row k="nonce" v={exec.typedData.message["nonce"]} mono />
          <Row k={tx(locale, "deadline")} v={fmtLocal(Number(exec.typedData.message["deadline"]), locale)} mono />
        </Card>
      )}

      {exec && (
        <Card title={tx(locale, "sign_send_card")}>
          <ol className="space-y-3 text-sm">
            <li className="flex flex-wrap items-center gap-3">
              <span className="w-64">{t("step_approve")}</span>
              {approved ? <Pill tone="ok">{t("approve_done")}</Pill> : (
                <button className="btn" disabled={!(step === "prepared" || step === "idle") || !!gate} onClick={doApprove} aria-busy={step === "approving"}>{step === "approving" ? (walletBusy ? tx(locale, "approve_pending") : tx(locale, "approve_mining")) : tx(locale, "approve_btn", { amount: inAmt(exec.approval.amount) })}</button>
              )}
            </li>
            <li className="flex flex-wrap items-center gap-3">
              <span className="w-64">{t("step_sign_3")}</span>
              {intentSig ? <Pill tone="ok">{tx(locale, "signed")}</Pill> : (
                <button className="btn" disabled={!!gate || !(step === "approved" || (approved && step === "prepared")) } onClick={doSignAndSend} aria-busy={step === "signing"}>{step === "signing" ? tx(locale, "sign_pending") : t("sign_and_send")}</button>
              )}
              {intentSig && step === "signed" && <button className="btn" disabled={!!gate} onClick={doSend}>{tx(locale, "execute_btn")}</button>}
              {step === "sending" && <Pill tone="warn">{tx(locale, "send_pending")}</Pill>}
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
              {!txHash ? null : !serverExec ? <Pill tone="warn">{tx(locale, "server_receipt_wait")}</Pill> : (
                <>
                  <Pill tone={execStateTone(serverExec.state)}>{serverExec.state}</Pill>
                  {serverExec.state === "REORG_PENDING" && serverExec.receipt && <span className="text-xs text-fg-2">{tx(locale, "confirmations", { n: serverExec.receipt.confirmations ?? 0, m: serverExec.receipt.requiredConfirmations ?? 0 })}</span>}
                  {serverExec.receipt?.event && <span className="mono text-xs text-fg-2">{tx(locale, "server_receipt_line", { spent: inAmt(serverExec.receipt.event.spent), received: outAmt(serverExec.receipt.event.received), refunded: inAmt(serverExec.receipt.event.refunded) })}</span>}
                  {serverExec.state === "UNKNOWN" && serverExec.receipt?.reason && <span className="text-xs text-fg-2">{serverExec.receipt.reason}</span>}
                </>
              )}
            </li>
          </ol>
          {gate && <p className="mt-2 text-xs text-fg-2">{gate}</p>}
          {step === "expired" && <p className="mt-3 text-sm text-warn">{t("expired")}</p>}
        </Card>
      )}
    </div>
  );
}
