"use client";
/** 授权任务的两条列表：评估时间线（每次检查的结论 + 变化）与步骤回执（每步状态、交易、服务端核实的支出 / 到账 / 退回） */
import type { MandateView } from "@/lib/api-v2";
import { Amount } from "@/components/kit/Amount";
import { Hash } from "@/components/kit/Hash";
import { Panel } from "@/components/kit/Panel";
import { ToneTag } from "@/components/kit/StatusBadge";
import { Timestamp } from "@/components/kit/Timestamp";
import { useI18n } from "@/lib/i18n";
import { blockerText } from "@/components/kit/Blockers";
import { execStateText, execStateToneV8, reasonOverride } from "@/components/features/report/labels";
import { unitOf, type AssetLite } from "@/components/features/report/model";
import { MANDATE_EVAL } from "./copy";
import { evaluationsOf } from "./taskModel";

export function TaskTimeline({ m }: { m: MandateView }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const evals = evaluationsOf(m);
  return (
    <Panel>
      <Panel.Header title={zh ? "检查时间线" : "Check timeline"} description={zh ? `共 ${evals.length} 次检查` : `${evals.length} checks`} />
      <Panel.Body>
        {evals.length === 0 ? <p className="text-sm text-fg-3">{zh ? "还没有检查记录。" : "No checks yet."}</p> : (
          <ul className="flex max-h-96 flex-col divide-y divide-line overflow-y-auto">
            {evals.map((e) => {
              const ev = MANDATE_EVAL[e.status];
              const why = e.delta ? (zh ? e.delta.summary.zh : e.delta.summary.en) : e.reasons.filter((r) => r.severity !== "info").map((r) => reasonOverride(r.code, locale) ?? blockerText({ code: r.code }, locale)).join(zh ? "；" : "; ");
              return (
                <li key={e.evaluationId} className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-1 py-2 text-sm">
                  <span className="w-28 shrink-0 text-xs text-fg-3"><Timestamp at={e.evaluatedAt} mode="abs" /></span>
                  {ev ? <ToneTag tone={ev.tone}>{ev[locale]}</ToneTag> : null}
                  <span className="min-w-0 flex-1 text-fg-2">{why || "—"}</span>
                  {e.preparedStepIndex !== null ? <span className="text-xs text-fg-3 tabular-nums">{zh ? `第 ${e.preparedStepIndex} 步` : `Step ${e.preparedStepIndex}`}</span> : null}
                </li>
              );
            })}
          </ul>
        )}
      </Panel.Body>
    </Panel>
  );
}

type Ev = { spent?: string; received?: string; refunded?: string };

export function TaskSteps({ m, assets }: { m: MandateView; assets: AssetLite[] | null }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const inU = unitOf(assets, m.inputAssetKey);
  return (
    <Panel>
      <Panel.Header title={zh ? "步骤与回执" : "Steps and receipts"} description={zh ? "只有「链上已确认成交」才算成交。" : "Only a confirmed on-chain fill counts."} />
      <Panel.Body>
        {m.steps.length === 0 ? <p className="text-sm text-fg-3">{zh ? "还没有执行过的步骤。" : "No steps yet."}</p> : (
          <ul className="flex flex-col divide-y divide-line">
            {m.steps.map((s) => {
              const outU = s.step ? unitOf(assets, s.step.outputToken) : { decimals: null, symbol: null };
              const ev = s.receipt && typeof s.receipt["event"] === "object" && s.receipt["event"] !== null ? (s.receipt["event"] as Ev) : null;
              return (
                <li key={`${s.stepIndex}:${s.state}:${s.txHash ?? ""}`} className="flex min-w-0 flex-col gap-1 py-2.5 text-sm">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="text-fg-1 tabular-nums">#{s.stepIndex}</span>
                    <ToneTag tone={execStateToneV8(s.state)}>{execStateText(s.state, locale)}</ToneTag>
                    {s.step ? <span className="text-fg-2"><Amount raw={s.step.amountIn} decimals={inU.decimals} symbol={inU.symbol} maxFrac={4} /> → ≥ <Amount raw={s.step.minAmountOut} decimals={outU.decimals} symbol={outU.symbol} maxFrac={6} /></span> : null}
                    {s.txHash ? <Hash value={s.txHash} kind="tx" className="ml-auto" /> : null}
                  </span>
                  {ev ? (
                    <span className="flex flex-wrap gap-x-3 text-xs text-fg-2">
                      <span>{zh ? "支出" : "Spent"} <Amount raw={ev.spent ?? null} decimals={inU.decimals} symbol={inU.symbol} maxFrac={4} /></span>
                      <span>{zh ? "到账" : "Received"} <Amount raw={ev.received ?? null} decimals={outU.decimals} symbol={outU.symbol} maxFrac={6} /></span>
                      <span>{zh ? "退回" : "Refunded"} <Amount raw={ev.refunded ?? null} decimals={inU.decimals} symbol={inU.symbol} maxFrac={4} /></span>
                    </span>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </Panel.Body>
    </Panel>
  );
}
