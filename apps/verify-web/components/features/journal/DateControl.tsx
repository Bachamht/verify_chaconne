"use client";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { isDay, shiftTradingDay } from "./receipts";

/** 交易日选择：前一天 / 日期框 / 后一天 /「最新」；值写进 URL（?date=），留空 = 最近一个已生成的 */
export function DateControl({ value, latest, onChange }: { value: string; latest: boolean; onChange: (d: string | null) => void }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const ok = isDay(value);
  // 禁用的翻页按钮要有可见原因（C3）
  const why = !ok ? (zh ? "日期读取中，暂时不能翻页" : "Loading the date; paging is unavailable") : null;
  return (
    <div className="flex min-w-0 flex-wrap items-end gap-2">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="journal-date" className="text-xs text-fg-2">{zh ? "交易日（纽约）" : "Trading day (New York)"}</Label>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="icon" aria-label={zh ? "前一个交易日" : "Previous trading day"} disabled={!ok} aria-describedby={!ok ? "journal-date-why" : undefined} onClick={() => onChange(shiftTradingDay(value, -1))}>
            <ChevronLeft aria-hidden="true" />
          </Button>
          <Input id="journal-date" type="date" className="w-40 tabular-nums" value={ok ? value : ""} onChange={(e) => onChange(e.target.value || null)} />
          <Button variant="outline" size="icon" aria-label={zh ? "后一个交易日" : "Next trading day"} disabled={!ok || latest} aria-describedby={!ok ? "journal-date-why" : undefined} onClick={() => onChange(shiftTradingDay(value, 1))}>
            <ChevronRight aria-hidden="true" />
          </Button>
        </div>
      </div>
      {why ? <span id="journal-date-why" className="pb-2 text-xs text-fg-3">{why}</span> : null}
      {latest ? null : <Button variant="ghost" size="sm" onClick={() => onChange(null)}>{zh ? "回到最新" : "Back to latest"}</Button>}
    </div>
  );
}
