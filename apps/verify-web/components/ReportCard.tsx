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

const TONE: Record<PublicReport["status"], "ok" | "warn" | "bad" | "neutral" | "brand"> = { completed: "ok", partial: "warn", waiting: "neutral", rejected: "bad", simulation: "brand" };

export function ReportCard({ r, compact = false }: { r: PublicReport; compact?: boolean }) {
  const { t, locale } = useI18n();
  const zh = locale === "zh";
  const title = r.headline ? (zh ? r.headline.zh : r.headline.en) : headline(r.status, r.persona?.personaId ?? null, locale);
  const goalLine = `${r.goal.side === "buy" ? t("plan_side_buy") : t("plan_side_sell")} ${r.goal.outputSymbols.join(" + ")} ${zh ? "用" : "with"} ${r.goal.inputSymbol}${r.goal.amountDisplay ? ` · ${r.goal.amountDisplay}` : ""} · ${r.goal.policyId}`;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        {r.persona && <PersonaArt id={r.persona.personaId} size={compact ? 56 : 88} />}
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone={TONE[r.status]}>{t(`status_${r.status}` as "status_completed")}</Pill>
            <Pill tone={r.evidenceMode === "LIVE" ? "ok" : r.evidenceMode === "SIMULATION" ? "brand" : "warn"}>{r.evidenceMode}</Pill>
          </div>
          <h2 className={`${compact ? "text-lg" : "text-2xl"} font-bold`}>{title}</h2>
          {r.persona && <p className="text-xs text-neutral-400">{r.persona.name} · {zh ? PERSONAS[r.persona.personaId].name.zh : PERSONAS[r.persona.personaId].name.en}</p>}
        </div>
      </div>
      {!compact && (
        <>
          <Card>
            <Row k={zh ? "目标" : "Goal"} v={goalLine} />
            <Row k={t("plan_completion")} v={r.result.completionBps === null ? "—" : `${(r.result.completionBps / 100).toFixed(0)}%`} mono />
            <Row k={zh ? "支出 / 到账" : "Spent / received"} v={`${r.result.spentDisplay ?? "—"} / ${r.result.receivedDisplay ?? "—"}`} mono />
            <Row k={zh ? "费用" : "Fees"} v={r.result.feesDisplay ?? "—"} mono />
            {r.result.waitingOn && <Row k={t("status_waiting")} v={r.result.waitingOn} />}
            {r.result.reasons.length > 0 && <Row k={t("reasons")} v={r.result.reasons.map((x) => reasonText(x.code, locale)).join("; ")} />}
          </Card>
          <Card title={t("report_evidence")}>
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
