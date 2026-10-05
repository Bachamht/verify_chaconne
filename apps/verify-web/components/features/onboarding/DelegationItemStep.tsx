"use client";
import type { DelegationItem } from "@chaconne/core/verify";
import { Button } from "@/components/ui/button";
import { Hash } from "@/components/kit/Hash";
import { StepFlow, type StepState } from "@/components/kit/StepFlow";
import { ToneTag } from "@/components/kit/StatusBadge";
import { errorText } from "@/lib/errors";
import { useI18n, type Locale } from "@/lib/i18n";
import { tv, type V7Key } from "@/lib/i18n.v7";
import type { Tone } from "@/lib/status";
import { sellAssetOf } from "@/components/agent/delegation/delegationModel";

const STATUS_TONE: Record<DelegationItem["status"], Tone> = { confirmed: "ok", not_needed: "ok", submitted: "info", failed: "bad", todo: "neutral" };

/** 一项失败的原因 → 人话：已知错误码走 lib/errors；未知码不露原始码（中文页也不夹服务端英文原文） */
export function itemFailReason(error: { code?: string; message?: string }, locale: Locale): string {
  const generic = locale === "zh" ? "服务没有给出可读的原因，稍后重新读取授权清单再试" : (error.message || "the service gave no readable reason; reload the checklist and try again later");
  return errorText(error.code, locale, generic);
}

/** 委托清单的一项 → 竖排 StepFlow 的一步：已生效 / 不需要 = done，失败 = failed，正在签 / 已提交 = active，待签 = idle */
export function itemStepState(status: DelegationItem["status"], current: boolean): StepState {
  if (current) return "active";
  if (status === "confirmed" || status === "not_needed") return "done";
  if (status === "failed") return "failed";
  if (status === "submitted") return "active";
  return "idle";
}

export function DelegationItemStep({ item, index, current, phaseText, symbol, last, onRefreshSell, fixture }: {
  item: DelegationItem;
  index: number;
  current: boolean;
  phaseText: string | null;
  symbol: string;
  last: boolean;
  onRefreshSell: () => void;
  fixture: boolean;
}) {
  const { locale } = useI18n();
  const kindKey = (item.kind === "mandate_buy" ? "d_kind_mandate_buy" : item.kind === "mandate_sell" ? "d_kind_mandate_sell" : "d_kind_permit") as V7Key;
  const sellAsset = sellAssetOf(item.id);
  return (
    <StepFlow.Step
      index={index}
      last={last}
      locale={locale}
      state={itemStepState(item.status, current)}
      title={item.title[locale] || `${tv(locale, kindKey)} · ${symbol}`}
      meta={<ToneTag tone={STATUS_TONE[item.status]}>{tv(locale, `d_status_${item.status}` as V7Key)}</ToneTag>}
      description={item.explain[locale]}
    >
      {current && phaseText ? <p className="text-sm text-brand-300" role="status">{phaseText}</p> : null}
      {item.status === "not_needed" ? <p className="text-xs text-fg-3">{tv(locale, "d_not_needed_note")}</p> : null}
      {item.status === "failed" && item.error ? <p className="text-sm text-bad">{tv(locale, "d_item_failed", { why: itemFailReason(item.error, locale) })}</p> : null}
      {item.status === "failed" && sellAsset && !item.typedData ? <Button type="button" size="sm" variant="outline" disabled={fixture} onClick={onRefreshSell}>{tv(locale, "d_refresh_sell")}</Button> : null}
      {item.kind === "permit" && item.txHash ? <span className="flex items-center gap-2 text-xs text-fg-2">{tv(locale, "d_tx_link")}<Hash value={item.txHash} kind="tx" /></span> : null}
    </StepFlow.Step>
  );
}
