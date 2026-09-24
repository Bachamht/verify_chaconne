"use client";
/** 报告页 / 执行页的人类单位（V-37）：原始单位 → 「5 USDG」「≈0.01488 AAPLx」，价格 2–4 位小数，时刻带标签。lib/format.ts 由另一条线维护，新助手放这里。 */
import type { Locale } from "./i18n";
import { fmtUnits } from "./wallet";

/**
 * 原始单位 → 人类数量 + 符号。整数部分 ≥ 1 时最多 4 位小数；小于 1 时保留 4 位有效数字（最多 8 位小数）。
 * approx=true 前缀「≈」（报价估算，不是结算额）。raw 非法时原样返回，不猜。
 */
export function fmtAmount(raw: string | bigint | null | undefined, decimals: number, symbol: string, opts: { approx?: boolean } = {}): string {
  if (raw === null || raw === undefined || raw === "") return "—";
  let s: string;
  try {
    s = fmtUnits(raw, decimals, Math.max(decimals, 8));
  } catch {
    return String(raw);
  }
  const [i = "0", f = ""] = s.split(".");
  let frac = f;
  if (i !== "0") frac = f.slice(0, 4);
  else {
    const lead = f.match(/^0*/)?.[0].length ?? 0;
    frac = f.slice(0, Math.min(8, lead + 4));
  }
  frac = frac.replace(/0+$/, "");
  const num = frac ? `${i}.${frac}` : i;
  return `${opts.approx ? "≈" : ""}${num}${symbol ? ` ${symbol}` : ""}`;
}

/** 价格串 → 2–4 位小数（≥ 1 两位，< 1 四位）；非数字原样返回 */
export function fmtPrice(v: string | number | null | undefined, currency = "$"): string {
  if (v === null || v === undefined || v === "") return "—";
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return String(v);
  const digits = Math.abs(n) >= 1 ? 2 : 4;
  return `${currency}${n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** 本地时刻 HH:mm:ss（给「重置于 14:20:18」这类带标签的短时间） */
export function fmtClock(input: string | number | Date | null | undefined, locale: Locale = "en"): string {
  if (input === null || input === undefined || input === "") return "—";
  const d = input instanceof Date ? input : new Date(typeof input === "number" && input < 1e12 ? input * 1000 : input);
  if (Number.isNaN(d.getTime())) return String(input);
  try {
    return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(d);
  } catch {
    return d.toLocaleTimeString();
  }
}

/** 资产登记表里的精度与符号；查不到时按 assetKey 猜不出来就用保守默认（稳定币 6 位、股票代币 18 位）并把符号留空 */
export interface AssetMeta { assetKey: string; tokenDecimals: number; displaySymbol: string; role?: "stable_input" | "stock_output" }
export function assetMeta(list: AssetMeta[] | null | undefined, assetKey: string, fallbackRole: "stable_input" | "stock_output"): { decimals: number; symbol: string; known: boolean } {
  const hit = list?.find((a) => a.assetKey === assetKey);
  if (hit) return { decimals: hit.tokenDecimals, symbol: hit.displaySymbol, known: true };
  return { decimals: fallbackRole === "stable_input" ? 6 : 18, symbol: "", known: false };
}
