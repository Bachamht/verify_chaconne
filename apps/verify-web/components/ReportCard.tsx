"use client";
/** 战报三层：标题 + 关键结果 / 目标、完成比例、费用、等待或失败原因 / 证据与验证器链接 */
import Link from "next/link";
import type { PublicReport } from "@/lib/api-v2";
import { useI18n } from "@/lib/i18n";
import { reasonText } from "@/lib/reasons";
import { headline } from "@/lib/report-copy";
import { Card, Pill, Row } from "@/components/ui";
import { PersonaArt, PERSONAS } from "@/components/personas";
import { EXPLORER, short } from "@/lib/wallet";
import { formatTime } from "@/lib/format";
import "./verification-workspace.css";

const TONE: Record<PublicReport["status"], "ok" | "warn" | "bad" | "neutral" | "brand"> = { completed: "ok", partial: "warn", waiting: "neutral", rejected: "bad", simulation: "brand" };

export function ReportCard({ r, compact = false }: { r: PublicReport; compact?: boolean }) {
  const { t, locale } = useI18n();
  const zh = locale === "zh";
  const title = r.headline ? (zh ? r.headline.zh : r.headline.en) : headline(r.status, r.persona?.personaId ?? null, locale);
  const goalLine = `${r.goal.side === "buy" ? t("plan_side_buy") : t("plan_side_sell")} ${r.goal.outputSymbols.join(" + ")} ${zh ? "用" : "with"} ${r.goal.inputSymbol}${r.goal.amountDisplay ? ` · ${r.goal.amountDisplay}` : ""} · ${r.goal.policyId}`;
  return (
    <div className={`cvf-public-report ${compact ? "cvf-public-report--compact" : ""}`}>
      <div className="cvf-public-report-header" data-status={r.status}>
        {r.persona && <div className="cvf-public-persona"><PersonaArt id={r.persona.personaId} size={compact ? 56 : 72} /></div>}
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={TONE[r.status]}>{t(`status_${r.status}` as "status_completed")}</Pill>
            <Pill tone={r.evidenceMode === "LIVE" ? "ok" : r.evidenceMode === "SIMULATION" ? "brand" : "warn"}>{r.evidenceMode}</Pill>
          </div>
          <h2 className="cvf-public-title">{title}</h2>
          {r.persona && (() => {
            const kind = zh ? PERSONAS[r.persona.personaId].name.zh : PERSONAS[r.persona.personaId].name.en;
            const custom = r.persona.name?.trim();
            // 角色卡不重复：「节拍龟 · 节拍龟」→「节拍龟」；起了名才显示「小龟 · 节拍龟」
            return <p className="text-xs text-fg-2">{custom && custom !== kind && custom !== PERSONAS[r.persona.personaId].name.zh && custom !== PERSONAS[r.persona.personaId].name.en ? `${custom} · ${kind}` : kind}</p>;
          })()}
          {!compact && <p className="cvf-public-record-note">{r.status === "simulation" || r.evidenceMode === "SIMULATION" ? (zh ? "模拟核验记录 · 不代表已执行交易" : "Simulation record · no executed trade is implied") : (zh ? "任务结果记录 · 以报告与链上回执为准" : "Task result record · refer to the report and on-chain receipts")}</p>}
        </div>
      </div>
      {!compact && (
        <>
          <Card className="cvf-detail-card cvf-public-summary">
            <Row k={zh ? "目标" : "Goal"} v={goalLine} />
            <dl className="cvf-public-metrics">
              <div><dt>{t("plan_completion")}</dt><dd className="mono">{r.result.completionBps === null ? "—" : `${(r.result.completionBps / 100).toFixed(0)}%`}</dd></div>
              <div><dt>{zh ? "支出 / 到账" : "Spent / received"}</dt><dd className="mono">{r.result.spentDisplay ?? "—"}<span className="cvf-metric-separator"> / </span>{r.result.receivedDisplay ?? "—"}</dd></div>
              <div><dt>{zh ? "费用" : "Fees"}</dt><dd className="mono">{r.result.feesDisplay ?? "—"}</dd></div>
            </dl>
            {r.result.waitingOn && <Row k={t("status_waiting")} v={r.result.waitingOn} />}
            {r.result.reasons.length > 0 && <Row k={t("reasons")} v={r.result.reasons.map((x) => reasonText(x.code, locale)).join("; ")} />}
          </Card>
          {r.kind === "job" && r.check && (() => {
            const c = r.check;
            const session = ({ REGULAR: zh ? "美股常规时段" : "US regular session", PRE: zh ? "盘前" : "pre-market", POST: zh ? "盘后" : "after-hours", CLOSED: zh ? "休市" : "closed", HOLIDAY: zh ? "假日休市" : "holiday" } as Record<string, string>)[c.marketSession] ?? c.marketSession;
            const dev = c.reference?.deviationBps;
            return (
              <Card title={zh ? "核验结果（这是一次核验，不是成交）" : "Check result (a check, not a fill)"} className="cvf-detail-card">
                <Row k={zh ? "判定" : "Verdict"} v={<Pill tone={c.executionEligible ? "ok" : "bad"}>{c.executionEligible ? (zh ? "可执行：通过全部限制" : "eligible: within every limit") : (zh ? "不可执行" : "not eligible")}</Pill>} />
                <Row k={zh ? "策略" : "Policy"} v={c.policyId} mono />
                <Row k={zh ? "市场时段" : "Market session"} v={`${session}${c.comparisonStatus === "live" ? (zh ? " · 实时参考价" : " · live reference") : c.comparisonStatus === "official_close" ? (zh ? " · 官方收盘价" : " · official close") : ""}`} />
                {c.reference && <Row k={zh ? "参考价" : "Reference price"} v={`$${c.reference.priceUsd}${c.reference.sourcePublishedAt ? ` · ${formatTime(c.reference.sourcePublishedAt, locale)}` : c.reference.tradingDate ? ` · ${c.reference.tradingDate}` : ""}`} mono />}
                {c.executableUsdPerShare && <Row k={zh ? "链上可执行单价" : "Executable price on-chain"} v={`$${c.executableUsdPerShare}${dev !== null && dev !== undefined ? ` (${dev > 0 ? "+" : ""}${(dev / 100).toFixed(2)}% ${zh ? "相对参考价" : "vs reference"})` : ""}`} mono />}
                {c.adverseImpactBps !== null && <Row k={zh ? "价格冲击" : "Price impact"} v={`${c.adverseImpactBps} bps`} mono />}
                <Row k={zh ? "核验时间" : "Checked at"} v={formatTime(c.evaluatedAt, locale)} mono />
                <p className="mt-3 text-xs text-fg-2">{r.evidence.txHashes.length > 0 ? (zh ? "这笔已上链，交易哈希见下方「证据与验证器」，点开即到区块浏览器。" : "This one was executed; the transaction hash is under Evidence below and opens the block explorer.") : (zh ? "核验通过不等于买入：没有任何资金移动。要真的成交，要在任务里授权（你的钱包签名），由 Agent 提交意图、拿到步骤证书后上链；成交后交易哈希会出现在这一页和任务页，一键打开区块浏览器。核验结果只代表核验那一刻，交易前请重新核验。" : "A passed check is not a purchase: no funds moved. To trade for real, authorize the task with your wallet, let the agent submit an intent and take the step certificate on-chain; the transaction hash then shows on this page and on the task page with a block-explorer link. The verdict is a snapshot of that moment; re-check before trading.")}</p>
              </Card>
            );
          })()}
          <Card title={t("report_evidence")} className="cvf-detail-card">
            {r.evidence.reportHash && <Row k="reportHash" v={r.evidence.reportHash} mono />}
            {r.evidence.evidenceHash && <Row k="evidenceHash" v={r.evidence.evidenceHash} mono />}
            {r.evidence.txHashes.map((h) => (
              <Row key={h} k="tx" v={<a className="underline" href={`${EXPLORER}/tx/${h}`} target="_blank" rel="noreferrer">{short(h)}</a>} mono />
            ))}
            <div className="mt-3 flex flex-wrap gap-2">
              <Link href="/verify-bundle" className="btn-ghost px-3 py-1 text-sm">{t("nav_verify_bundle")}</Link>
              {r.templateId && <Link href={`/${r.kind === "job" ? "new" : "plan"}?template=${r.templateId}`} className="btn px-3 py-1 text-sm">{t("share_remix")}</Link>}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
