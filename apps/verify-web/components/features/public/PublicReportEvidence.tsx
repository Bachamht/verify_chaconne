"use client";
import Link from "next/link";
import { Blockers } from "@/components/kit/Blockers";
import { Hash } from "@/components/kit/Hash";
import { KeyValue } from "@/components/kit/KeyValue";
import { Panel } from "@/components/kit/Panel";
import { Button } from "@/components/ui/button";
import { useI18n } from "@/lib/i18n";
import { policyLabel } from "@/lib/policyLabels";
import type { PublicReportView } from "./publicView";
import { GoalLine } from "./ReportBadges";

/** 目标 + 等待 / 理由（理由走 kit Blockers：原因码 → 人话，未映射的不露 SNAKE_CASE） */
export function PublicReportGoal({ view }: { view: PublicReportView }) {
  const { t, locale } = useI18n();
  const zh = locale === "zh";
  return (
    <Panel>
      <Panel.Header title={zh ? "目标" : "Goal"} />
      <Panel.Body>
        <KeyValue items={[
          { key: "goal", label: zh ? "目标" : "Goal", value: <GoalLine goal={view.goal} /> },
          { key: "policy", label: zh ? "策略" : "Policy", value: <span title={view.goal.policyId}>{policyLabel(view.goal.policyId, locale)}</span> },
          ...(view.waitingOn ? [{ key: "wait", label: t("status_waiting"), value: view.waitingOn }] : []),
        ]} />
        {view.reasonCodes.length > 0 ? (
          <div className="mt-4">
            <p className="mb-2 text-xs font-medium text-fg-2">{t("reasons")}</p>
            <Blockers items={view.reasonCodes.map((code) => ({ code }))} hideNextCheck />
          </div>
        ) : null}
      </Panel.Body>
    </Panel>
  );
}

/** 证据与验证器：报告哈希 / 证据哈希 / 交易哈希（可复制、交易可开浏览器）+ 一个主动作 + 一个次动作 */
export function PublicReportEvidence({ view }: { view: PublicReportView }) {
  const { t, locale } = useI18n();
  const zh = locale === "zh";
  const h = view.hashes;
  const items = [
    ...(h.reportHash ? [{ key: "rh", label: zh ? "报告哈希" : "Report hash", value: <Hash value={h.reportHash} /> }] : []),
    ...(h.evidenceHash ? [{ key: "eh", label: zh ? "证据哈希" : "Evidence hash", value: <Hash value={h.evidenceHash} /> }] : []),
    ...h.txHashes.map((tx, i) => ({ key: `tx${i}`, label: zh ? "链上交易" : "Transaction", value: <Hash value={tx} kind="tx" /> })),
  ];
  return (
    <Panel>
      <Panel.Header title={t("report_evidence")} description={zh ? "拿证据包在浏览器里离线复核哈希与签名。" : "Re-check the hashes and signatures offline in your browser with the evidence bundle."} />
      <Panel.Body>
        {items.length > 0 ? <KeyValue items={items} /> : <p className="text-sm text-fg-2">{zh ? "这份战报没有附带哈希。" : "This report carries no hashes."}</p>}
      </Panel.Body>
      <Panel.Footer>
        <Button asChild size="sm" variant="outline"><Link href="/verify-bundle">{t("nav_verify_bundle")}</Link></Button>
      </Panel.Footer>
    </Panel>
  );
}
