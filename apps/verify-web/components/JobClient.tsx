"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, type AssetsResponse } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { reasonText } from "@/lib/reasons";
import { Card, Pill, Row, EmptyState } from "@/components/ui";
import { Conductor, type ConductorState } from "@/components/Conductor";
import { fmtLocal } from "@/lib/format";
import { assetMeta, fmtAmount, fmtClock, fmtPrice } from "@/lib/format.execute";
import { tx } from "@/lib/i18n.execute";
import { EXPLORER, short } from "@/lib/wallet";
import { MAIN_SITE_URL } from "@/lib/productSwitch";
import { jobsV2 } from "@/lib/api-v2";
import { useAccount } from "@/lib/useAccount";
import { BillPanel } from "@/components/BillPanel";
import { ShareSettings } from "@/components/ShareSettings";
import type { Bill } from "@chaconne/core/verify";
import "./verification-workspace.css";

/** 证据 kind 的展示名（V-15）：`pyth_reference` 是历史命名（CV-D01 已泛化为"实时参考 tick"），按 provider 显示中性名；不改冻结的 kind 值 */
export function evidenceKindLabel(kind: string, provider: string): string {
  if (kind === "pyth_reference") return `stock_reference (${provider})`;
  if (kind === "ref_close") return `stock_close (${provider})`;
  return kind;
}

export interface JobView {
  jobId: string;
  clientRequestId: string;
  requestHash: string;
  job: { ownerAddress: string; recipientAddress: string; inputAssetKey: string; outputAssetKey: string; amountInRaw: string; policyId: string; policyVersion: string; params: Record<string, number | null> };
  policyDefinitionHash: string;
  effectivePolicyHash: string;
  registryVersion: string;
  registryHash: string;
  createdAt: string;
  order: { orderId: string; state: string; priceUsd: string; network: string; settledAt: string | null; deliveredAt: string | null };
  entitlement: { expiresAt: string; maxRefreshes: number; usedRefreshes: number; remaining: number } | null;
  latestReport: { version: number; verdict: string; executionEligible: boolean; evaluatedAt: string; evidenceHash: string } | null;
  executions: Array<{ attemptId: string; reportVersion: number; state: string; validUntil: string | null; txHash: string | null; receipt: ExecutionReceipt | null }>;
  evidenceMode: "FIXTURE" | "LIVE";
}

/** 服务端链上核实器写入的回执摘要（不信任客户端成功声明） */
export interface ExecutionReceipt {
  status?: "success" | "reverted";
  reason?: string;
  blockNumber?: string;
  confirmations?: number;
  requiredConfirmations?: number;
  checkedAt?: string;
  confirmedAt?: string;
  event?: { spent: string; received: string; refunded: string; recipient: string };
}

export function execStateTone(state: string): "ok" | "warn" | "bad" | "neutral" {
  if (state === "CONFIRMED") return "ok";
  if (state === "REVERTED" || state === "REJECTED") return "bad";
  if (state === "SUBMITTED" || state === "REORG_PENDING" || state === "UNKNOWN") return "warn";
  return "neutral";
}

export interface Report {
  verdict: string;
  executionEligible: boolean;
  comparisonStatus: string;
  marketSession: string;
  evaluatedAt: string;
  reasons: Array<{ code: string; severity: string; evidenceIds: string[]; detail?: Record<string, unknown> }>;
  normalizedQuote: { amountInRaw: string; expectedOutRaw: string; minOutRaw: string; priceImpactPercent: string | null; adverseImpactBps: number | null; receivedAt: string; executableUsdPerShare: string | null } | null;
  reference: { underlyingId: string; priceUsd: string; kind: string; tradingDate: string | null; sourcePublishedAt: string | null; sourceId: string; deviationBps: number | null } | null;
  evidenceHash: string;
  evidenceIds: string[];
  reportVersion: number;
  policySnapshot: unknown;
}

interface ReportResponse {
  report: Report;
  reportHash: string;
  evidence: Array<{ evidenceId: string; provider: string; endpoint: string; mode: string; time: { requestedAt: string; receivedAt: string; sourcePublishedAt: string | null }; rawHash: string; payload: { kind: string } & Record<string, unknown> }>;
}

export function JobClient({ jobId }: { jobId: string }) {
  const { t, locale } = useI18n();
  const [job, setJob] = useState<JobView | null>(null);
  const [rep, setRep] = useState<ReportResponse | null>(null);
  const [status, setStatus] = useState<number | null>(null);
  const [bill, setBill] = useState<Bill | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  /** 资产登记表：只为把原始单位换成「5 USDG / ≈0.01488 AAPLx」（V-37） */
  const [assets, setAssets] = useState<AssetsResponse["assets"] | null>(null);
  useEffect(() => {
    api<AssetsResponse>("GET", "v1/assets").then((r) => r.status === 200 && Array.isArray(r.data?.assets) && setAssets(r.data.assets)).catch(() => undefined);
  }, []);

  /** 已连接钱包就按它当调用方（?owner= → 代理写 x-verify-caller）：Agent 经 MCP / A2MCP 为这个钱包建的核验，网页才能打开（FIX-174） */
  const account = useAccount();
  const ownerQ = account ? `?owner=${account.toLowerCase()}` : "";
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError(false);
    try {
      const j = await api<JobView>("GET", `v1/jobs/${jobId}${ownerQ}`);
      setStatus(j.status);
      if (j.status !== 200) return;
      setJob(j.data);
      const r = await api<ReportResponse | { error: string }>("GET", `v1/jobs/${jobId}/report${ownerQ}`);
      if (r.status === 200) setRep(r.data as ReportResponse);
      else if (r.status === 402) setRep(null);
      else setLoadError(true);
      const b = await jobsV2.bill(jobId, account);
      setBill(b.status === 200 ? b.data : null);
    } catch {
      setLoadError(true);
    } finally {
      setLoading(false);
    }
  }, [jobId, ownerQ, account]);

  useEffect(() => {
    void load();
  }, [load]);

  const zh = locale === "zh";
  if (loadError && !job) return <EmptyState title={t("err_generic")} description={t("err_p")} primary={{ onClick: () => void load(), label: zh ? "重试" : "Try again" }} secondary={{ href: "/me", label: t("nav_me") }} />;
  if (status && status !== 200)
    return status === 404 ? (
      <EmptyState title={t("task_nf_h")} description={account ? t("task_nf_p") : (zh ? "这条核验只对它所属的钱包可见。先在右上角连接创建它的钱包（Agent 替你核验时填的那个地址），再打开这个链接。" : "This verification is only visible to the wallet it belongs to. Connect the wallet the agent verified for (the address it used), then open this link again.")} primary={{ href: "/agent/tasks", label: t("nav_me") }} secondary={{ href: "/agent", label: t("nav_new") }} />
    ) : (
      <EmptyState title={`${t("err_generic")} ${status}`} description={t("err_p")} primary={{ href: "/", label: t("nf_home") }} />
    );
  if (!job) return (
    <section className="cvf-loading-panel" aria-busy="true" role="status">
      <Conductor state="checking" variant="compact" locale={locale} />
      <p className="cvf-eyebrow">VERIFY / REPORT</p>
      <h1>{zh ? "正在读取核验记录" : "Loading the verification record"}</h1>
      <p>{zh ? "正在获取这份任务的报告与证据。" : "Retrieving the report and evidence for this job."}</p>
    </section>
  );
  const report = rep?.report ?? null;
  const inMeta = assetMeta(assets, job.job.inputAssetKey, "stable_input");
  const outMeta = assetMeta(assets, job.job.outputAssetKey, "stock_output");
  const inAmt = (raw: string | null | undefined, approx = false) => fmtAmount(raw, inMeta.decimals, inMeta.symbol, { approx });
  const outAmt = (raw: string | null | undefined, approx = false) => fmtAmount(raw, outMeta.decimals, outMeta.symbol, { approx });
  const modeTone = job.evidenceMode === "LIVE" ? "ok" : "warn";
  // The character reflects the saved report, never a claim that an old quote is executable now.
  const reportState: ConductorState = !report ? "idle"
    : report.reasons.some((r) => r.code === "QUOTE_TOO_OLD" && r.severity === "block") ? "expired"
      : !report.executionEligible || report.verdict === "rejected" || report.reasons.some((r) => r.severity === "block") ? "blocked" : "passed";
  const reportHeading = report?.verdict === "rejected"
    ? zh ? "这轮核验，未通过。" : "This check did not pass."
    : report?.verdict === "limited"
      ? zh ? "证据还不够，暂不可执行。" : "Insufficient evidence. Execution unavailable."
      : reportState === "passed"
        ? zh ? "这轮证据，符合条件。" : "These checks met the conditions."
        : zh ? "这轮核验，暂不可执行。" : "This check did not permit execution.";

  return (
    <div className="cvf-workspace cvf-report-workspace">
      <header className="cvf-report-heading">
        <div><p className="cvf-eyebrow">VERIFY / EVIDENCE RECORD</p><h1>{zh ? "核验报告" : "Verification report"}</h1></div>
        <div className="flex flex-wrap items-center gap-2">
        <Pill tone={modeTone}>{job.evidenceMode}</Pill>
        <Pill>{job.job.policyId}</Pill>
        {report && <Pill>{t("session")}: {report.marketSession}</Pill>}
        </div>
      </header>
      <p className="cvf-record-id mono">{job.jobId}</p>
      {loadError && <div className="cvf-inline-error" role="alert"><span>{zh ? "部分记录未能更新，下面保留已读取的内容。" : "Some records could not be refreshed. Previously loaded content remains below."}</span><button className="btn-ghost" onClick={() => void load()} disabled={loading}>{zh ? "重试" : "Try again"}</button></div>}

      {report ? (
        <>
          <section className="cvf-verdict-panel" data-verdict={report.verdict} aria-labelledby="verify-verdict-heading">
            <div className="cvf-verdict-copy">
              <div className="flex flex-wrap items-center gap-2"><p className="cvf-eyebrow">{zh ? "本次报告结论" : "RESULT AT EVALUATION"}</p><Pill tone={report.verdict === "rejected" ? "bad" : report.verdict === "limited" ? "warn" : reportState === "passed" ? "ok" : "neutral"}>{report.verdict}</Pill></div>
              <h2 id="verify-verdict-heading">{reportHeading}</h2>
              <p className="cvf-report-time">{zh ? "核验时间" : "Evaluated"} · <time dateTime={report.evaluatedAt}>{fmtLocal(report.evaluatedAt, locale)}</time></p>
              <p className="cvf-verdict-note">{!report.executionEligible ? (zh ? "本轮不签发执行证明。需要重新核验并取得符合条件的新报告，才能准备执行。" : "No execution certificate is issued for this evaluation. A new check and an eligible report are required before preparing execution.") : (zh ? "这是核验时点的记录，不代表此刻仍可成交。执行前必须重新核验、取得有效证明，并由钱包签名。" : "This records the evaluation at that time, not a currently executable quote. Execution requires a new check, a valid certificate and a wallet signature.")}</p>
              <div className="cvf-report-actions"><Link href={`/jobs/${job.jobId}/execute`} className="btn">{reportState === "passed" ? t("prepare_exec") : zh ? "重新核验" : "Re-verify"} <span aria-hidden>↗</span></Link><a className="cvf-text-link" href="#verify-report-evidence">{zh ? "查看证据" : "Inspect the evidence"} <span aria-hidden>↓</span></a></div>
            </div>
            <Conductor state={reportState} variant="compact" locale={locale} className="cvf-verdict-conductor" />
          </section>
          <dl className="cvf-report-metrics">
            <div><dt>{zh ? "报告中的报价单价" : "Quoted price in this report"}</dt><dd className="mono" title={report.normalizedQuote?.executableUsdPerShare ?? undefined}>{fmtPrice(report.normalizedQuote?.executableUsdPerShare)}<span>{tx(locale, "usd_per_share")}</span></dd></div>
            <div><dt>{zh ? "价格冲击" : "Price impact"}</dt><dd className="mono">{report.normalizedQuote?.adverseImpactBps === null || report.normalizedQuote?.adverseImpactBps === undefined ? "—" : report.normalizedQuote.adverseImpactBps}<span>{report.normalizedQuote?.adverseImpactBps === null || report.normalizedQuote?.adverseImpactBps === undefined ? (zh ? "未知" : "unknown") : "bps"}</span></dd></div>
            <div><dt>{zh ? "股票参考价" : "Stock reference"}</dt><dd className="mono" title={report.reference?.priceUsd}>{report.reference ? fmtPrice(report.reference.priceUsd) : "—"}<span>{report.reference?.kind ?? (zh ? "未提供" : "not provided")}</span></dd></div>
          </dl>
          {(report.reasons.some((r) => r.code === "CLOSE_UNCONFIRMED") || report.reference?.kind === "close_last_tick") && (
            <div className="rounded-xl border border-warn/40 bg-warn/10 px-4 py-3 text-sm text-warn">
              <span className="mono mr-2 text-xs">CLOSE_UNCONFIRMED</span>
              {t("close_unconfirmed_note")}
            </div>
          )}
          <div className="cvf-report-details grid gap-4 md:grid-cols-2">
            <Card title={t("reasons")} className="cvf-detail-card">
              <ul className="cvf-reason-list text-sm">
                {report.reasons.map((r, i) => (
                  <li key={i} className="flex gap-2">
                    <Pill tone={r.severity === "block" ? "bad" : r.severity === "warning" ? "warn" : "neutral"}>{r.severity}</Pill>
                    <span>
                      {reasonText(r.code, locale)} <span className="mono text-xs text-fg-3">{r.code}</span>
                    </span>
                  </li>
                ))}
                {report.reasons.length === 0 && <li className="text-fg-2">{zh ? "报告未返回额外原因。" : "No additional reasons were returned in this report."}</li>}
              </ul>
            </Card>
            <Card title={t("reference")} className="cvf-detail-card">
              {report.reference ? (
                <>
                  <Row k={report.reference.underlyingId} v={fmtPrice(report.reference.priceUsd)} mono />
                  <Row k={locale === "zh" ? "类型" : "Kind"} v={<Pill tone={report.reference.kind === "live" ? "ok" : report.reference.kind.includes("close") ? "brand" : "warn"}>{report.reference.kind}</Pill>} />
                  <Row k={locale === "zh" ? "交易日" : "Trading date"} v={report.reference.tradingDate ?? "—"} mono />
                  <Row k={locale === "zh" ? "源时间" : "Source time"} v={report.reference.sourcePublishedAt ? fmtLocal(report.reference.sourcePublishedAt, locale) : (locale === "zh" ? "未提供" : "not provided")} mono />
                  <Row k={locale === "zh" ? "来源" : "Source"} v={report.reference.sourceId} mono />
                  <Row k={locale === "zh" ? "可执行价 vs 参考" : "Executable vs reference"} v={report.reference.deviationBps === null ? "—" : `${report.reference.deviationBps > 0 ? "+" : ""}${(report.reference.deviationBps / 100).toFixed(2)}%`} mono />
                  <Row k={locale === "zh" ? "可比性" : "Comparison"} v={report.comparisonStatus} mono />
                  <a className="mt-2 inline-block text-xs text-brand underline" href={`${MAIN_SITE_URL}/compare#${encodeURIComponent(report.reference.underlyingId.split(":").pop() ?? "")}`} target="_blank" rel="noreferrer">
                    {t("see_compare_main")}
                  </a>
                </>
              ) : (
                <p className="text-sm text-fg-2">{report.comparisonStatus}</p>
              )}
            </Card>
            <Card title={t("quote")} className="cvf-detail-card">
              {report.normalizedQuote ? (
                <>
                  <Row k={tx(locale, "input_amount")} v={inAmt(report.normalizedQuote.amountInRaw)} mono />
                  <Row k={tx(locale, "expected_out")} v={outAmt(report.normalizedQuote.expectedOutRaw, true)} mono />
                  <Row k={tx(locale, "min_out")} v={outAmt(report.normalizedQuote.minOutRaw)} mono />
                  <Row k={locale === "zh" ? "价格冲击" : "Price impact"} v={report.normalizedQuote.adverseImpactBps === null ? (locale === "zh" ? "未知（不当作 0）" : "unknown (not treated as 0)") : `${report.normalizedQuote.adverseImpactBps} bps`} mono />
                  <Row k={locale === "zh" ? "可执行单价" : "Executable price"} v={`${fmtPrice(report.normalizedQuote.executableUsdPerShare)} ${tx(locale, "usd_per_share")}`} mono />
                  <Row k={locale === "zh" ? "报价接收时间" : "Quote received"} v={fmtLocal(report.normalizedQuote.receivedAt, locale)} mono />
                  <p className="mt-2 text-xs text-fg-3">{tx(locale, "approx_note")}</p>
                </>
              ) : (
                <p className="text-sm text-fg-2">—</p>
              )}
            </Card>
            <Card title={t("task_record")} className="cvf-detail-card">
              <Row k={t("payment")} v={<Pill tone={["PAID", "DELIVERED", "SETTLEMENT_PENDING"].includes(job.order.state) ? "ok" : "warn"}>{job.order.priceUsd === "0" ? tx(locale, "free_this_time") : `${job.order.state} · ${fmtPrice(job.order.priceUsd)}`}</Pill>} />
              <Row k={t("report_versions")} v={`v${job.latestReport?.version ?? 1}`} mono />
              <Row k={t("refreshes_left")} v={job.entitlement ? `${job.entitlement.remaining} / ${job.entitlement.maxRefreshes} · ${tx(locale, "reset_at", { t: fmtClock(job.entitlement.expiresAt, locale) })}` : "—"} mono />
              <Row k={t("executions")} v={job.executions.length === 0 ? "—" : job.executions.map((e) => (
                <span key={e.attemptId} className="block">
                  <Pill tone={execStateTone(e.state)}>{e.state}</Pill> {e.txHash && (<a className="underline" href={`${EXPLORER}/tx/${e.txHash}`} target="_blank" rel="noreferrer">{short(e.txHash)}</a>)}
                  {e.receipt?.event && <span className="ml-2 text-fg-2">{t("receipt_verified")} · {tx(locale, "server_receipt_line", { spent: inAmt(e.receipt.event.spent), received: outAmt(e.receipt.event.received), refunded: inAmt(e.receipt.event.refunded) })}</span>}
                  {e.state === "REORG_PENDING" && e.receipt && <span className="ml-2 text-fg-2">{tx(locale, "confirmations", { n: e.receipt.confirmations ?? 0, m: e.receipt.requiredConfirmations ?? 0 })}</span>}
                  {e.state === "UNKNOWN" && e.receipt?.reason && <span className="ml-2 text-fg-2">{e.receipt.reason}</span>}
                </span>
              ))} mono />
              <div className="mt-3 flex flex-wrap gap-2">
                <Link href={`/jobs/${job.jobId}/execute`} className="btn">{t("prepare_exec")}</Link>
                <Link href={`/verify-bundle?job=${job.jobId}`} className="btn-ghost">{t("nav_verify_bundle")}</Link>
                <button className="btn-ghost" onClick={() => void load()} disabled={loading} aria-label={zh ? "刷新报告记录" : "Refresh report record"}>{loading ? t("loading") : "↻"}</button>
              </div>
            </Card>
          </div>

          <div id="verify-report-evidence" className="cvf-evidence-section">
          <Card title={t("evidence")} className="cvf-detail-card">
            <p className="mb-5 text-sm text-fg-2">{zh ? "以下为这份报告实际使用的证据。来源与时间保留，供你逐项核对。" : "Evidence used by this report, with sources and timestamps available for inspection."}</p>
            <ul className="cvf-evidence-list text-sm">
              {rep?.evidence.map((e, i) => (
                <li key={e.evidenceId}>
                  <span className="cvf-evidence-index mono" aria-hidden>{String(i + 1).padStart(2, "0")}</span>
                  <div className="cvf-evidence-body"><div className="flex flex-wrap items-center gap-2">
                  <Pill tone={e.mode === "LIVE" ? "ok" : "warn"}>{e.mode}</Pill>
                  <span className="mono" title={e.payload.kind}>{evidenceKindLabel(e.payload.kind, e.provider)}</span>
                  </div><p className="mt-2 text-fg-2">{e.provider} · {e.endpoint}</p>
                  <p className="mono mt-2 text-xs text-fg-3">{zh ? "源时间" : "Source"} {e.time.sourcePublishedAt ? fmtLocal(e.time.sourcePublishedAt, locale) : "—"}<br />{zh ? "接收时间" : "Received"} {fmtLocal(e.time.receivedAt, locale)}</p></div>
                </li>
              ))}
            </ul>
          </Card>
          </div>

          <div className="grid gap-4 md:grid-cols-2">
            <BillPanel bill={bill} />
            <ShareSettings kind="job" refId={job.jobId} />
          </div>
        </>
      ) : (
        <Card className="cvf-pending-report" title={loading ? (zh ? "正在读取报告" : "Loading the report") : loadError ? (zh ? "报告暂时无法读取" : "Report temporarily unavailable") : (zh ? "报告尚未交付" : "Report not delivered yet")}>
          <p className="text-sm leading-7 text-neutral-300">{loading ? t("loading") : loadError ? t("err_p") : job.order.state === "PAYMENT_REQUIRED" || job.order.state === "REPORT_READY" ? (locale === "zh" ? "报告需付款后交付（x402）。此版本网页尚不内置付款，请用 Agent/OKX AI 或 API 付款。" : "Report requires x402 payment. This web build does not embed the payer; pay via your agent / OKX AI or the API.") : job.order.state}</p>
          {!loading && <button className="btn-ghost mt-4" onClick={() => void load()}>{zh ? "刷新交付状态" : "Refresh delivery status"}</button>}
        </Card>
      )}
    </div>
  );
}
