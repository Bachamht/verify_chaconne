"use client";
import { KeyValue } from "@/components/kit/KeyValue";
import { Panel } from "@/components/kit/Panel";
import { Amount } from "@/components/kit/Amount";
import { ToneTag } from "@/components/kit/StatusBadge";
import { Timestamp } from "@/components/kit/Timestamp";
import { bpsPercent, tradingDateText } from "@/components/features/report/labels";
import { useI18n } from "@/lib/i18n";
import { policyLabel, sessionText } from "@/lib/policyLabels";
import type { PublicReportView } from "./publicView";

/** 单笔核验（kind=job）的公开结果：说清「这是一次核验，不是成交」 */
export function ReportCheck({ check, executed }: { check: NonNullable<PublicReportView["check"]>; executed: boolean }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const c = check;
  const dev = bpsPercent(c.reference?.deviationBps);
  const impact = bpsPercent(c.adverseImpactBps, false);
  const refDate = c.reference?.sourcePublishedAt ? <Timestamp at={c.reference.sourcePublishedAt} mode="abs" /> : tradingDateText(c.reference?.tradingDate, locale);
  const cmp = c.comparisonStatus === "live" ? (zh ? " · 实时参考价" : " · live reference") : c.comparisonStatus === "official_close" ? (zh ? " · 官方收盘价" : " · official close") : "";
  const items = [
    { key: "verdict", label: zh ? "判定" : "Verdict", value: <ToneTag tone={c.executionEligible ? "ok" : "bad"}>{c.executionEligible ? (zh ? "可执行：通过全部限制" : "eligible: within every limit") : (zh ? "不可执行" : "not eligible")}</ToneTag> },
    { key: "policy", label: zh ? "策略" : "Policy", value: <span title={c.policyId}>{policyLabel(c.policyId, locale)}</span> },
    { key: "session", label: zh ? "市场时段" : "Market session", value: `${sessionText(c.marketSession, locale)}${cmp}` },
    ...(c.reference ? [{ key: "ref", label: zh ? "参考价" : "Reference price", value: <span className="tabular-nums"><Amount value={c.reference.priceUsd} prefix="$" maxFrac={2} minFrac={2} />{refDate ? <> · {refDate}</> : null}</span> }] : []),
    ...(c.executableUsdPerShare ? [{ key: "exec", label: zh ? "链上报价单价" : "On-chain quoted price", value: <span className="tabular-nums"><Amount value={c.executableUsdPerShare} prefix="$" maxFrac={2} minFrac={2} />{dev ? ` (${dev} ${zh ? "相对参考价" : "vs reference"})` : ""}</span> }] : []),
    ...(impact ? [{ key: "impact", label: zh ? "价格冲击" : "Price impact", value: <span className="tabular-nums">{impact}</span> }] : []),
    { key: "at", label: zh ? "核验时间" : "Checked at", value: <Timestamp at={c.evaluatedAt} mode="abs" /> },
  ];
  return (
    <Panel>
      <Panel.Header title={zh ? "核验结果（这是一次核验，不是成交）" : "Check result (a check, not a fill)"} />
      <Panel.Body>
        <KeyValue items={items} />
        <p className="mt-3 text-sm leading-6 text-fg-2">
          {executed
            ? (zh ? "附有链上交易，结果以链上回执为准：交易哈希见下方「证据与验证器」，点开即到区块浏览器查看是否成功。" : "An on-chain transaction is attached; its receipt decides the outcome. The hash is under Evidence below and opens the block explorer, where you can see whether it succeeded.")
            : (zh ? "核验通过不等于买入：没有任何资金移动。要真的成交，要在任务里授权（你的钱包签名），由 Agent 提交意图、拿到步骤证书后上链；成交后交易哈希会出现在这一页和任务页，一键打开区块浏览器。核验结果只代表核验那一刻，交易前请重新核验。" : "A passed check is not a purchase: no funds moved. To trade for real, authorize the task with your wallet, let the agent submit an intent and take the step certificate on-chain; the transaction hash then shows on this page and on the task page with a block-explorer link. The verdict is a snapshot of that moment; re-check before trading.")}
        </p>
      </Panel.Body>
    </Panel>
  );
}
