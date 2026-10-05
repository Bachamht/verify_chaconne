/**
 * v8 数字与时间的纯函数（kit 的 Amount / Timestamp 用；不依赖 React，单测覆盖）。
 * 金额全程用字符串 / bigint 运算，不经过 Number，避免精度丢失。
 */
import type { Locale } from "./i18n";

/** raw（最小单位整数串）→ 十进制串；非法返回 null。截断而非四舍五入，与链上一致 */
export function rawToDecimal(raw: string | bigint, decimals: number, maxFrac: number): string | null {
  let s: string;
  try {
    s = BigInt(raw).toString();
  } catch {
    return null;
  }
  const neg = s.startsWith("-");
  if (neg) s = s.slice(1);
  const pad = s.padStart(decimals + 1, "0");
  const int = decimals > 0 ? pad.slice(0, -decimals) : pad;
  let frac = decimals > 0 ? pad.slice(-decimals) : "";
  frac = frac.slice(0, Math.max(0, maxFrac)).replace(/0+$/, "");
  return `${neg ? "-" : ""}${int}${frac ? `.${frac}` : ""}`;
}

/** 十进制串加千分位，并补到最少小数位：("1234.5", 2) → "1,234.50" */
export function groupDecimal(value: string, minFrac = 0): string {
  const neg = value.startsWith("-");
  const [i = "0", f = ""] = (neg ? value.slice(1) : value).split(".");
  const int = i.replace(/^0+(?=\d)/, "").replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = f.padEnd(minFrac, "0");
  return `${neg ? "-" : ""}${int}${frac ? `.${frac}` : ""}`;
}

/** 表格列用的紧凑写法：1.2K / 3.4M；只给已是十进制的值 */
export function compactDecimal(value: string, locale: Locale): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return value;
  return new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

/** 接受 ISO / unix 秒 / unix 毫秒 / Date；非法返回 null */
export function toDate(input: string | number | Date | null | undefined): Date | null {
  if (input === null || input === undefined || input === "") return null;
  let d: Date;
  if (input instanceof Date) d = input;
  else if (typeof input === "number") d = new Date(input < 1e12 ? input * 1000 : input);
  else if (/^\d+$/.test(input)) d = new Date(Number(input) < 1e12 ? Number(input) * 1000 : Number(input));
  else d = new Date(input);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 绝对时间：同一年省略年份 → "10/03 14:34"；跨年 → "2025/10/03 14:34" */
export function formatAbs(d: Date, locale: Locale, now: Date = new Date()): string {
  const sameYear = d.getFullYear() === now.getFullYear();
  // 中文 10/03 14:34；英文用月份缩写（3 Oct 14:34），避免 03/10 被读成 3 月 10 日
  const opts: Intl.DateTimeFormatOptions = locale === "zh"
    ? { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false, ...(sameYear ? {} : { year: "numeric" }) }
    : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false, ...(sameYear ? {} : { year: "numeric" }) };
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-GB", opts).format(d).replace(",", "");
}

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 365 * 86400], ["month", 30 * 86400], ["week", 7 * 86400], ["day", 86400], ["hour", 3600], ["minute", 60], ["second", 1],
];

/** 相对时间："2 小时前" / "in 3 min"；45 秒内写「刚刚 / just now」 */
export function formatRel(d: Date, locale: Locale, now: Date = new Date()): string {
  const diff = Math.round((d.getTime() - now.getTime()) / 1000);
  const abs = Math.abs(diff);
  if (abs < 45) return locale === "zh" ? (diff <= 0 ? "刚刚" : "马上") : diff <= 0 ? "just now" : "in a moment";
  const rtf = new Intl.RelativeTimeFormat(locale === "zh" ? "zh-CN" : "en", { numeric: "auto", style: "short" });
  for (const [unit, sec] of UNITS) if (abs >= sec || unit === "second") return rtf.format(Math.round(diff / sec), unit);
  return "";
}

/** 倒计时 "12:04" / "1:02:03"；已过 → "0:00" */
export function formatCountdown(msLeft: number): string {
  const s = Math.max(0, Math.floor(msLeft / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

/** 中间截断：0xbacb…0381 */
export function middleTruncate(value: string, head = 6, tail = 4): string {
  return value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`;
}
