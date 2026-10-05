"use client";
import { CalendarClock } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { RecapPendingView } from "@/lib/api-v2";
import { Button } from "@/components/ui/button";
import { Panel } from "@/components/kit/Panel";
import { EmptyState } from "@/components/kit/FourStates";
import { Timestamp } from "@/components/kit/Timestamp";
import { dayText, shiftTradingDay } from "./receipts";

/** 这一天还没生成（或不是交易日）：说清原因与生成时刻，动作 = 看上一个交易日。服务端 note 是英文，不显示 */
export function PendingDay({ p, onPrev }: { p: RecapPendingView; onPrev: (d: string) => void }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const day = dayText(p.date, locale);
  const title = !p.tradingDay
    ? (zh ? `${day} 不是交易日` : `${day} is not a trading day`)
    : (zh ? `${day} 的日志还没生成` : `The ${day} journal is not generated yet`);
  const desc = !p.tradingDay
    ? (zh ? "美股休市，这一天没有日志。" : "The US market was closed; there is no journal for this day.")
    : (
      <>
        {zh ? "纽约实际收盘后 45 分钟生成" : "Generated 45 minutes after the actual New York close"}
        {p.earlyClose ? (zh ? "（今天提前收盘）" : " (early close today)") : ""}
        {p.generateAfterUtc ? <>{zh ? "，预计 " : ", expected "}<Timestamp at={p.generateAfterUtc} mode="both" /></> : null}
        {zh ? "。" : "."}
      </>
    );
  return (
    <Panel>
      <EmptyState
        art={<CalendarClock className="size-8 text-fg-3" strokeWidth={1.5} aria-hidden="true" />}
        title={title}
        description={desc}
        action={<Button variant="outline" size="sm" onClick={() => onPrev(shiftTradingDay(p.date, -1))}>{zh ? "看上一个交易日" : "Open the previous trading day"}</Button>}
      />
    </Panel>
  );
}
