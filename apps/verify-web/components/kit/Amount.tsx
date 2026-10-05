"use client";
import { useI18n } from "@/lib/i18n";
import { compactDecimal, groupDecimal, rawToDecimal } from "@/lib/numbers";
import { cn } from "@/lib/utils";

type AmountProps = {
  /** 原始单位整数串；与 decimals 一起用。页面上永不直接显示 raw */
  raw?: string | bigint | null;
  decimals?: number | null;
  /** 已是十进制的值（如价格 "337.02"）；与 raw 二选一 */
  value?: string | number | null;
  symbol?: string | null;
  /** 最多小数位（截断）；默认 6，稳定币传 2 */
  maxFrac?: number;
  minFrac?: number;
  /** 表格列：1.2K */
  compact?: boolean;
  /** 前缀，如 "$" */
  prefix?: string;
  className?: string;
};

/** 金额：tabular-nums、人类单位、千分位；未知 → "—" 并标「未返回」（不补 0） */
export function Amount({ raw, decimals, value, symbol, maxFrac = 6, minFrac = 0, compact = false, prefix, className }: AmountProps) {
  const { locale } = useI18n();
  let dec: string | null = null;
  if (value !== undefined && value !== null && value !== "") dec = typeof value === "number" ? numberToDecimal(value) : value;
  else if (raw !== undefined && raw !== null && raw !== "" && typeof decimals === "number") dec = rawToDecimal(raw, decimals, maxFrac);
  if (dec === null) {
    return <span className={cn("tabular-nums text-fg-3", className)} title={locale === "zh" ? "未返回" : "Not returned"}>—</span>;
  }
  const text = compact ? compactDecimal(dec, locale) : groupDecimal(trimFrac(dec, maxFrac), minFrac);
  return (
    <span className={cn("tabular-nums whitespace-nowrap", className)} title={raw !== undefined && raw !== null ? `${String(raw)} (raw)` : undefined}>
      {prefix}{text}{symbol ? <span className="ml-1 text-[0.86em] text-fg-2">{symbol}</span> : null}
    </span>
  );
}

/** number → 十进制串，不出科学计数法（1e-7 → "0.0000001"，1e21 → "1000000000000000000000"）；非有限数 → null */
export function numberToDecimal(n: number): string | null {
  if (!Number.isFinite(n)) return null;
  return n.toLocaleString("en-US", { useGrouping: false, maximumFractionDigits: 20 });
}

function trimFrac(dec: string, maxFrac: number): string {
  const [i, f] = dec.split(".");
  if (!f) return dec;
  const cut = f.slice(0, maxFrac).replace(/0+$/, "");
  return cut ? `${i}.${cut}` : (i ?? "0");
}
