"use client";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { reasonText } from "@/lib/reasons";
import { Card, Json, Pill, Row, VerdictBadge, EmptyState } from "@/components/ui";
import { EXPLORER, short } from "@/lib/wallet";
import { MAIN_SITE_URL } from "@/lib/productSwitch";
import { jobsV2 } from "@/lib/api-v2";
import { BillPanel } from "@/components/BillPanel";
import { ShareSettings } from "@/components/ShareSettings";
import type { Bill } from "@chaconne/core/verify";

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
  const [showDev, setShowDev] = useState(false);
  const [bill, setBill] = useState<Bill | null>(null);

  const load = useCallback(async () => {
    const j = await api<JobView>("GET", `v1/jobs/${jobId}`);
    setStatus(j.status);
    if (j.status !== 200) return;
    setJob(j.data);
    const r = await api<ReportResponse | { error: string }>("GET", `v1/jobs/${jobId}/report`);
    if (r.status === 200) setRep(r.data as ReportResponse);
    else setRep(null);
    const b = await jobsV2.bill(jobId);
    setBill(b.status === 200 ? b.data : null);
  }, [jobId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (status && status !== 200)
    return status === 404 ? (
      <EmptyState title={t("task_nf_h")} description={t("task_nf_p")} primary={{ href: "/me", label: t("nav_me") }} secondary={{ href: "/new", label: t("nav_new") }} />
    ) : (
      <EmptyState title={`${t("err_generic")} ${status}`} description={t("err_p")} primary={{ href: "/", label: t("nf_home") }} />
    );
  if (!job) return <p className="text-fg-2">{t("loading")}</p>;
  const report = rep?.report ?? null;
  const modeTone = job.evidenceMode === "LIVE" ? "ok" : "warn";

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">{locale === "zh" ? "核验报告" : "Verification report"}</h1>
        <Pill tone={modeTone}>{job.evidenceMode}</Pill>
        <Pill>{job.job.policyId}</Pill>
        {report && <Pill>{t("session")}: {report.marketSession}</Pill>}
        <span className="mono ml-auto text-xs text-fg-3">{job.jobId}</span>
      </div>

      {report ? (
        <>
          <VerdictBadge verdict={report.verdict} />
          {(report.reasons.some((r) => r.code === "CLOSE_UNCONFIRMED") || report.reference?.kind === "close_last_tick") && (
            <div className="rounded-xl border border-warn/40 bg-warn/10 px-4 py-3 text-sm text-warn">
              <span className="mono mr-2 text-xs">CLOSE_UNCONFIRMED</span>
              {t("close_unconfirmed_note")}
            </div>
          )}
          <div className="grid gap-4 md:grid-cols-2">
            <Card title={t("reasons")}>
              <ul className="space-y-2 text-sm">
                {report.reasons.map((r, i) => (
                  <li key={i} className="flex gap-2">
                    <Pill tone={r.severity === "block" ? "bad" : r.severity === "warning" ? "warn" : "neutral"}>{r.severity}</Pill>
                    <span>
                      {reasonText(r.code, locale)} <span className="mono text-xs text-fg-3">{r.code}</span>
                    </span>
                  </li>
                ))}
                {report.reasons.length === 0 && <li className="text-fg-2">—</li>}
              </ul>
            </Card>
            <Card title={t("reference")}>
              {report.reference ? (
                <>
                  <Row k={report.reference.underlyingId} v={`$${report.reference.priceUsd}`} mono />
                  <Row k={locale === "zh" ? "类型" : "Kind"} v={<Pill tone={report.reference.kind === "live" ? "ok" : report.reference.kind.includes("close") ? "brand" : "warn"}>{report.reference.kind}</Pill>} />
                  <Row k={locale === "zh" ? "交易日" : "Trading date"} v={report.reference.tradingDate ?? "—"} mono />
                  <Row k={locale === "zh" ? "源时间" : "Source time"} v={report.reference.sourcePublishedAt ?? (locale === "zh" ? "未提供" : "not provided")} mono />
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
            <Card title={t("quote")}>
              {report.normalizedQuote ? (
                <>
                  <Row k="amountIn" v={report.normalizedQuote.amountInRaw} mono />
                  <Row k="expectedOut" v={report.normalizedQuote.expectedOutRaw} mono />
                  <Row k={t("min_out")} v={report.normalizedQuote.minOutRaw} mono />
                  <Row k={locale === "zh" ? "价格冲击" : "Price impact"} v={report.normalizedQuote.adverseImpactBps === null ? (locale === "zh" ? "未知（不当作 0）" : "unknown (not treated as 0)") : `${report.normalizedQuote.adverseImpactBps} bps`} mono />
                  <Row k={locale === "zh" ? "可执行单价 (USD/股)" : "Executable USD/share"} v={report.normalizedQuote.executableUsdPerShare ?? "—"} mono />
                  <Row k={locale === "zh" ? "报价接收时间" : "Quote received"} v={report.normalizedQuote.receivedAt} mono />
                </>
              ) : (
                <p className="text-sm text-fg-2">—</p>
              )}
            </Card>
            <Card title={t("task_record")}>
              <Row k={t("payment")} v={<Pill tone={["PAID", "DELIVERED", "SETTLEMENT_PENDING"].includes(job.order.state) ? "ok" : "warn"}>{job.order.state}{job.order.priceUsd === "0" ? " · free" : ` · $${job.order.priceUsd}`}</Pill>} />
              <Row k={t("report_versions")} v={`v${job.latestReport?.version ?? 1}`} mono />
              <Row k={t("refreshes_left")} v={job.entitlement ? `${job.entitlement.remaining} / ${job.entitlement.maxRefreshes} · ${new Date(job.entitlement.expiresAt).toLocaleTimeString()}` : "—"} mono />
              <Row k={t("executions")} v={job.executions.length === 0 ? "—" : job.executions.map((e) => (
                <span key={e.attemptId} className="block">
                  <Pill tone={execStateTone(e.state)}>{e.state}</Pill> {e.txHash && (<a className="underline" href={`${EXPLORER}/tx/${e.txHash}`} target="_blank" rel="noreferrer">{short(e.txHash)}</a>)}
                  {e.receipt?.event && <span className="ml-2 text-fg-2">{t("receipt_verified")} · spent {e.receipt.event.spent} · received {e.receipt.event.received} · refunded {e.receipt.event.refunded}</span>}
                  {e.state === "REORG_PENDING" && e.receipt && <span className="ml-2 text-fg-2">{e.receipt.confirmations}/{e.receipt.requiredConfirmations} conf</span>}
                  {e.state === "UNKNOWN" && e.receipt?.reason && <span className="ml-2 text-fg-2">{e.receipt.reason}</span>}
                </span>
              ))} mono />
              <div className="mt-3 flex flex-wrap gap-2">
                <Link href={`/jobs/${job.jobId}/execute`} className="btn">{t("prepare_exec")}</Link>
                <Link href={`/verify-bundle?job=${job.jobId}`} className="btn-ghost">{t("nav_verify_bundle")}</Link>
                <button className="btn-ghost" onClick={() => void load()}>↻</button>
              </div>
            </Card>
          </div>

          <Card title={t("evidence")} right={<button className="btn-ghost px-3 py-1 text-xs" onClick={() => setShowDev(!showDev)}>{t("dev_details")}</button>}>
            <ul className="space-y-1 text-sm">
              {rep?.evidence.map((e) => (
                <li key={e.evidenceId} className="flex flex-wrap items-center gap-2">
                  <Pill tone={e.mode === "LIVE" ? "ok" : "warn"}>{e.mode}</Pill>
                  <span className="mono" title={e.payload.kind}>{evidenceKindLabel(e.payload.kind, e.provider)}</span>
                  <span className="text-fg-2">{e.provider} · {e.endpoint}</span>
                  <span className="mono ml-auto text-xs text-fg-3">src {e.time.sourcePublishedAt ?? "—"} · recv {e.time.receivedAt}</span>
                </li>
              ))}
            </ul>
            {showDev && (
              <div className="mt-3 space-y-2">
                <Row k="requestHash" v={job.requestHash} mono />
                <Row k="evidenceHash" v={report.evidenceHash} mono />
                <Row k="reportHash" v={rep?.reportHash} mono />
                <Row k="policyDefinitionHash" v={job.policyDefinitionHash} mono />
                <Row k="effectivePolicyHash" v={job.effectivePolicyHash} mono />
                <Row k="registryHash" v={job.registryHash} mono />
                <Json value={rep} />
              </div>
            )}
          </Card>

          <div className="grid gap-4 md:grid-cols-2">
            <BillPanel bill={bill} />
            <ShareSettings kind="job" refId={job.jobId} />
          </div>
        </>
      ) : (
        <Card>
          <p className="text-sm text-neutral-300">{job.order.state === "PAYMENT_REQUIRED" || job.order.state === "REPORT_READY" ? (locale === "zh" ? "报告需付款后交付（x402）。此版本网页尚不内置付款，请用 Agent/OKX AI 或 API 付款。" : "Report requires x402 payment. This web build does not embed the payer; pay via your agent / OKX AI or the API.") : job.order.state}</p>
        </Card>
      )}
    </div>
  );
}
