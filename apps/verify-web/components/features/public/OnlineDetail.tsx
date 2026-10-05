"use client";
import { Amount } from "@/components/kit/Amount";
import { useI18n } from "@/lib/i18n";
import { onlineDetailText, type OnlineInfo, type RawPart } from "./onlineChecks";

/** 精度来自登记表；查不到精度就不换算，写明「精度未知」 */
function Part({ label, part }: { label: string; part: RawPart | null }) {
  const { locale } = useI18n();
  if (!part) return null;
  return (
    <span className="whitespace-nowrap">
      {label} {part.decimals === null
        ? <span className="text-fg-3">{locale === "zh" ? "未登记资产，精度未知" : "unregistered asset, decimals unknown"}</span>
        : <Amount raw={part.raw} decimals={part.decimals} symbol={part.symbol} maxFrac={6} />}
    </span>
  );
}

/** 联网检查一条的人话 + 事件金额（人类单位） */
export function OnlineDetail({ info }: { info: OnlineInfo }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  return (
    <span className="flex flex-wrap gap-x-2">
      <span>{onlineDetailText(info, locale)}</span>
      {info.kind === "event" ? (
        <>
          <Part label={zh ? "支出" : "Spent"} part={info.spent} />
          <Part label={zh ? "到账" : "Received"} part={info.received} />
        </>
      ) : null}
    </span>
  );
}
