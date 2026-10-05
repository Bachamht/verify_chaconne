/**
 * 核验策略 / 美股时段的唯一一份人话映射（报告页、工具页、公开战报共用；页面不露 SNAKE_CASE，原值只放 title）。
 * 纯函数，单测见 test/v8Report.test.ts。
 */
import type { Locale } from "@/lib/i18n";

type L = { zh: string; en: string };

export const POLICY_IDS = ["STRICT_LIVE", "REFERENCE_CONTEXT", "QUOTE_ONLY"] as const;
const POLICY: Record<string, L & { noteZh: string; noteEn: string }> = {
  STRICT_LIVE: { zh: "严格实时", en: "Strict live", noteZh: "只在美股常规时段，要求实时参考价。休市或缺少实时参考时不可执行。", noteEn: "Regular US hours only, with a live stock reference. Closed markets or a missing live reference block execution." },
  REFERENCE_CONTEXT: { zh: "参考收盘价", en: "Close as context", noteZh: "允许用收盘价作背景，并核对来源与时效。收盘价不等于当前公允价。", noteEn: "Allows a closing price as context, with source and freshness checks. A close is not a current fair price." },
  QUOTE_ONLY: { zh: "只核对报价", en: "Quote only", noteZh: "只核对资产、路由与链上报价，不比较股票参考价；滑点与冲击上限照常生效。", noteEn: "Checks the asset, route and on-chain quote without a stock comparison. Slippage and impact limits still apply." },
};

/** 策略 id → 名称；认不出的写「自定义策略」，不露原始码 */
export function policyLabel(id: string | null | undefined, locale: Locale): string {
  return id && POLICY[id] ? POLICY[id]![locale] : locale === "zh" ? "自定义策略" : "Custom policy";
}

export function policyNote(id: string | null | undefined, locale: Locale): string {
  const p = id ? POLICY[id] : undefined;
  return p ? (locale === "zh" ? p.noteZh : p.noteEn) : "";
}

const SESSION: Record<string, L> = {
  REGULAR: { zh: "美股常规时段", en: "US regular session" },
  PRE: { zh: "盘前", en: "Pre-market" },
  POST: { zh: "盘后", en: "After-hours" },
  CLOSED: { zh: "休市", en: "Market closed" },
  HOLIDAY: { zh: "假日休市", en: "Holiday" },
};

/** 市场时段码 → 人话；认不出的写「时段未知」 */
export function sessionText(code: string | null | undefined, locale: Locale): string {
  return code && SESSION[code] ? SESSION[code]![locale] : locale === "zh" ? "时段未知" : "Session unknown";
}
