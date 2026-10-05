"use client";
import { useI18n } from "@/lib/i18n";
import { formatAbs, formatCountdown, formatRel, toDate } from "@/lib/numbers";
import { cn } from "@/lib/utils";
import { useNow } from "./useNow";

type Mode = "abs" | "rel" | "both";

/** 时间：默认 "10/03 14:34 · 2 小时前"，title 放 ISO；禁止页面直接渲染 ISO（E3）。表格列用 rel，证据区用 abs */
export function Timestamp({ at, mode = "both", className }: { at: string | number | Date | null | undefined; mode?: Mode; className?: string }) {
  const { locale } = useI18n();
  const now = useNow(mode === "abs" ? 3_600_000 : 30_000);
  const d = toDate(at);
  if (!d) return <span className={cn("tabular-nums text-fg-3", className)} title={locale === "zh" ? "未返回" : "Not returned"}>—</span>;
  const abs = formatAbs(d, locale, now ?? d);
  // 首帧（now 为 null）只出绝对时间，避免服务端与浏览器时钟不一致
  const rel = now ? formatRel(d, locale, now) : null;
  const text = mode === "abs" || !rel ? abs : mode === "rel" ? rel : `${abs} · ${rel}`;
  return (
    <time dateTime={d.toISOString()} title={d.toISOString()} className={cn("tabular-nums whitespace-nowrap", className)} suppressHydrationWarning>
      {text}
    </time>
  );
}

/** 倒计时（证书 TTL、下次检查）：到点后显示 doneLabel；每秒刷新 */
export function Countdown({ to, doneLabel, className }: { to: string | number | Date | null | undefined; doneLabel?: string; className?: string }) {
  const { locale } = useI18n();
  const now = useNow(1000);
  const d = toDate(to);
  if (!d) return <span className={cn("tabular-nums text-fg-3", className)}>—</span>;
  const left = now ? d.getTime() - now.getTime() : null;
  if (left !== null && left <= 0) return <span className={cn("text-fg-3", className)}>{doneLabel ?? (locale === "zh" ? "已到时间" : "Due now")}</span>;
  return (
    <time dateTime={d.toISOString()} title={d.toISOString()} className={cn("tabular-nums", className)} suppressHydrationWarning>
      {left === null ? formatAbs(d, locale) : formatCountdown(left)}
    </time>
  );
}
