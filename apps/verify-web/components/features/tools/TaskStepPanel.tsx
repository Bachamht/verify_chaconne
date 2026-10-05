"use client";
/** 「我来执行这一步」：最新评估 · 执行按钮（授权 → 准备 → 发送 → 等确认四段文案）· 本步证明与倒计时 · 交易与错误 */
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Amount } from "@/components/kit/Amount";
import { AsyncButton } from "@/components/kit/AsyncButton";
import { Blockers } from "@/components/kit/Blockers";
import { Hash } from "@/components/kit/Hash";
import { KeyValue } from "@/components/kit/KeyValue";
import { Panel } from "@/components/kit/Panel";
import { ToneTag } from "@/components/kit/StatusBadge";
import { Countdown, Timestamp } from "@/components/kit/Timestamp";
import { useI18n } from "@/lib/i18n";
import { toBlockerItems } from "@/components/features/report/ReasonList";
import { unitOf, type AssetLite } from "@/components/features/report/model";
import { MANDATE_EVAL } from "./copy";
import type { TaskMandate } from "./useTaskMandate";

export function TaskStepPanel({ t, assets }: { t: TaskMandate; assets: AssetLite[] | null }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const m = t.m!;
  const latest = m.latestEvaluation;
  const ev = latest ? MANDATE_EVAL[latest.status] : null;
  const busy = t.phase === "preparing" || t.phase === "approving" || t.phase === "sending" || t.phase === "pending";
  const pendingLabel = t.phase === "approving" ? (zh ? "授权额度中 · 请在钱包确认" : "Approving · confirm in wallet") : t.phase === "preparing" ? (zh ? "核验并取得证明…" : "Verifying for a certificate…") : t.phase === "sending" ? (zh ? "发送中 · 请在钱包确认" : "Sending · confirm in wallet") : (zh ? "已广播，等链上确认" : "Broadcast, awaiting confirmation");
  const s = t.prep?.step;
  const inU = unitOf(assets, m.inputAssetKey);
  const outU = s ? unitOf(assets, s.typedData.message.outputToken) : { decimals: null, symbol: null };
  return (
    <Panel>
      <Panel.Header title={zh ? "我来执行这一步" : "Execute this step myself"} description={zh ? "只授权这一步需要的金额。广播不等于成交，以链上确认为准。" : "Only the amount this step needs is approved. Broadcast is not a fill; only an on-chain confirmation counts."} />
      <Panel.Body className="flex flex-col gap-4">
        {latest && ev ? (
          <div className="flex flex-col gap-1 text-sm">
            <span className="flex flex-wrap items-center gap-2"><ToneTag tone={ev.tone}>{ev[locale]}</ToneTag><span className="text-fg-3"><Timestamp at={latest.evaluatedAt} /></span></span>
            {latest.delta ? <p className="text-fg-2">{zh ? latest.delta.summary.zh : latest.delta.summary.en}</p> : null}
          </div>
        ) : <p className="text-sm text-fg-2">{zh ? "还没有评估记录。" : "No evaluation yet."}</p>}
        <AsyncButton className="self-start" disabled={m.state !== "ACTIVE"} disabledReason={m.state !== "ACTIVE" ? (zh ? "只有运行中的任务能执行步骤。" : "Only an active task can execute a step.") : undefined} pending={busy} pendingLabel={pendingLabel} onClick={() => void t.executeStep()}>
          {zh ? "我来执行这一步" : "Execute this step"}
        </AsyncButton>
        {t.prep && !s ? (
          <div className="text-sm">
            <p className="text-fg-2">{zh ? "现在没有可执行的步骤，原因如下。" : "Nothing to execute right now, because:"}</p>
            <Blockers items={toBlockerItems(t.prep.reasons ?? [], locale)} />
          </div>
        ) : null}
        {s ? (
          <KeyValue dense items={[
            { label: zh ? "步骤" : "Step", value: `#${s.stepIndex}` },
            { label: zh ? "金额" : "Amount", value: <Amount raw={s.typedData.message.amountIn} decimals={inU.decimals} symbol={inU.symbol} maxFrac={4} /> },
            { label: zh ? "最少到账" : "Minimum received", value: <Amount raw={s.typedData.message.minAmountOut} decimals={outU.decimals} symbol={outU.symbol} maxFrac={6} /> },
            { label: zh ? "买入资产" : "Output", value: <Hash value={s.typedData.message.outputToken} kind="address" name={outU.symbol ?? undefined} /> },
            { label: zh ? "证明剩余" : "Certificate", value: <Countdown to={s.validUntil} doneLabel={zh ? "已过期" : "Expired"} /> },
            { label: zh ? "步骤摘要" : "Step digest", value: <Hash value={s.stepDigest} /> },
          ]} />
        ) : null}
        {t.txHash ? (
          <span className="flex flex-wrap items-center gap-2 text-sm text-fg-2">{zh ? "交易" : "Transaction"} <Hash value={t.txHash} kind="tx" />{t.phase === "done" ? <ToneTag tone="ok">{zh ? "链上已确认" : "Confirmed on-chain"}</ToneTag> : null}</span>
        ) : null}
        {t.msg ? <Alert variant="destructive" className="border-bad/35"><AlertDescription>{t.msg}</AlertDescription></Alert> : null}
      </Panel.Body>
    </Panel>
  );
}
