/**
 * 核验报告 / 执行 / 工具页共用的枚举 → 人话（v8：页面上不出现 SNAKE_CASE 与原始枚举，原值只放 title / 开发者视图）。
 * 纯函数，不引 React，单测见 test/v8Report.test.ts。
 */
import type { Locale } from "@/lib/i18n";
import type { Tone } from "@/lib/status";
import type { ReasonLevel } from "@/lib/reasonLevels";

type L = { zh: string; en: string };
const pick = (m: Record<string, L>, key: string | null | undefined, locale: Locale, fallback: L): string => (key && m[key] ? m[key]![locale] : fallback[locale]);

/* ---------- 策略 / 时段：唯一一份在 lib/policyLabels（公开战报也用它） ---------- */
export { POLICY_IDS, policyLabel, policyNote, sessionText } from "@/lib/policyLabels";

/* ---------- 结论 ---------- */
export type VerdictKind = "passed" | "blocked" | "limited" | "expired" | "none";
export interface VerdictInput { verdict: string; executionEligible: boolean; reasons: Array<{ code: string; severity: string }> }
export function verdictKind(r: VerdictInput | null | undefined): VerdictKind {
  if (!r) return "none";
  if (r.reasons.some((x) => x.code === "QUOTE_TOO_OLD" && x.severity === "block")) return "expired";
  if (r.verdict === "limited") return "limited";
  if (!r.executionEligible || r.verdict === "rejected" || r.reasons.some((x) => x.severity === "block")) return "blocked";
  return "passed";
}
const VERDICT: Record<VerdictKind, L & { tone: Tone }> = {
  passed: { zh: "这轮证据符合你的条件", en: "These checks met your conditions", tone: "ok" },
  blocked: { zh: "这轮核验未通过，暂不可执行", en: "This check did not pass. Execution is unavailable", tone: "bad" },
  limited: { zh: "证据还不够，暂不可执行", en: "Not enough evidence yet. Execution is unavailable", tone: "warn" },
  expired: { zh: "报价已过时，需要再核验", en: "The quote is too old. Re-verify first", tone: "warn" },
  none: { zh: "报告尚未交付", en: "Report not delivered yet", tone: "muted" },
};
export function verdictHeadline(k: VerdictKind, locale: Locale): string { return VERDICT[k][locale]; }
export function verdictTone(k: VerdictKind): Tone { return VERDICT[k].tone; }
/** 结论标签（徽章文字）：eligible / limited / rejected */
export function verdictTag(verdict: string | null | undefined, locale: Locale): string {
  return pick({ eligible: { zh: "可执行", en: "Eligible" }, limited: { zh: "证据不足", en: "Limited" }, rejected: { zh: "不可执行", en: "Rejected" } }, verdict, locale, { zh: "未知结论", en: "Unknown" });
}
export function verdictTagTone(verdict: string | null | undefined): Tone {
  return verdict === "eligible" ? "ok" : verdict === "limited" ? "warn" : verdict === "rejected" ? "bad" : "muted";
}

/* ---------- 参考价 / 可比性 ---------- */
export function referenceKindText(kind: string | null | undefined, locale: Locale): string {
  return pick({
    live: { zh: "实时参考价", en: "Live reference" }, official_close: { zh: "官方收盘价", en: "Official close" },
    close_cross_verified: { zh: "收盘价（两源核对）", en: "Close (cross-verified)" }, close_last_tick: { zh: "收盘价（最后一笔，待次日确认）", en: "Close (last trade, unconfirmed)" },
    provisional_close: { zh: "临时收盘价", en: "Provisional close" }, last_regular_observation: { zh: "常规时段最后观测", en: "Last regular-hours observation" },
  }, kind, locale, { zh: "参考价", en: "Reference" });
}
export function comparisonText(status: string | null | undefined, locale: Locale): string {
  return pick({
    live: { zh: "与实时参考价比较", en: "Compared with a live reference" }, official_close: { zh: "与收盘价比较", en: "Compared with the close" },
    not_requested: { zh: "按策略不比较", en: "Not compared, by policy" }, unverified: { zh: "参考价未经核实", en: "Reference unverified" },
  }, status, locale, { zh: "未比较", en: "Not compared" });
}

/* ---------- 证据 ---------- */
export function evidenceKindText(kind: string, locale: Locale): string {
  return pick({
    okx_quote: { zh: "链上报价", en: "On-chain quote" }, okx_rwa_token: { zh: "代币化股票信息", en: "Tokenized stock info" },
    pyth_reference: { zh: "股票参考价", en: "Stock reference" }, ref_close: { zh: "股票收盘价", en: "Stock close" },
    stablecoin_usd: { zh: "稳定币美元价", en: "Stablecoin USD price" }, token_meta: { zh: "代币信息（精度 / 符号）", en: "Token metadata" },
  }, kind, locale, { zh: "其它证据", en: "Other evidence" });
}
/** 证据条目右侧的值：美元价 / 原始单位数量（交给 Amount 换算）/ 文本 */
export type EvidenceValue = { kind: "usd"; value: string } | { kind: "out"; raw: string } | { kind: "text"; text: string } | null;
export function evidenceValue(payload: Record<string, unknown>): EvidenceValue {
  const s = (k: string) => (typeof payload[k] === "string" && payload[k] !== "" ? (payload[k] as string) : null);
  switch (payload["kind"]) {
    case "okx_quote": return s("expectedOutRaw") ? { kind: "out", raw: s("expectedOutRaw")! } : null;
    case "ref_close": return s("closeUsd") ? { kind: "usd", value: s("closeUsd")! } : null;
    case "pyth_reference": return s("priceUsd") ? { kind: "usd", value: s("priceUsd")! } : null;
    case "stablecoin_usd": return s("usdPerToken") ? { kind: "usd", value: s("usdPerToken")! } : null;
    case "okx_rwa_token": { const p = s("priceUsd") ?? s("stockPriceUsd"); return p ? { kind: "usd", value: p } : null; }
    case "token_meta": return s("symbol") ? { kind: "text", text: s("symbol")! } : null;
    default: return null;
  }
}

/* ---------- 原因（报告的 severity 优先于码表等级） ---------- */
export function severityLevel(severity: string): ReasonLevel {
  return severity === "block" ? "block" : severity === "warning" || severity === "warn" ? "warn" : "wait";
}
/** lib/reasons 里个别文案自带英文枚举，报告页覆盖成纯中文 / 纯英文 */
const REASON_OVERRIDE: Record<string, L> = {
  COMPARISON_NOT_REQUESTED: { zh: "只核对报价：按设计不比较股票参考价。", en: "Quote only: no stock comparison, by design." },
};
export function reasonOverride(code: string, locale: Locale): string | null {
  return REASON_OVERRIDE[code]?.[locale] ?? null;
}

/* ---------- 执行记录（服务端链上核实器的状态） ---------- */
const EXEC: Record<string, L & { tone: Tone }> = {
  PREPARED: { zh: "已准备，未发送", en: "Prepared, not sent", tone: "muted" },
  SUBMITTED: { zh: "已广播，等确认", en: "Broadcast, awaiting confirmation", tone: "info" },
  REORG_PENDING: { zh: "等更多区块确认", en: "Waiting for more confirmations", tone: "info" },
  CONFIRMED: { zh: "链上已确认成交", en: "Confirmed on-chain", tone: "ok" },
  REVERTED: { zh: "链上回滚，未成交", en: "Reverted on-chain", tone: "bad" },
  REJECTED: { zh: "被拒绝，未成交", en: "Rejected, not filled", tone: "bad" },
  UNKNOWN: { zh: "结果待核实", en: "Outcome being checked", tone: "warn" },
  EXPIRED: { zh: "证明过期，未发送", en: "Certificate expired, not sent", tone: "muted" },
  CREATED: { zh: "已创建", en: "Created", tone: "muted" },
  EVALUATING: { zh: "核验中", en: "Evaluating", tone: "info" },
  USER_SIGNING: { zh: "等你签名", en: "Waiting for your signature", tone: "warn" },
  SUPERSEDED: { zh: "已被新证明取代", en: "Superseded", tone: "muted" },
};
export function execStateText(state: string, locale: Locale): string {
  return pick(EXEC, state, locale, { zh: "状态未知", en: "Unknown state" });
}
export function execStateToneV8(state: string): Tone {
  return EXEC[state]?.tone ?? "muted";
}

/* ---------- 订单 ---------- */
export function orderStateText(state: string, locale: Locale): string {
  return pick({
    PAYMENT_REQUIRED: { zh: "待付款", en: "Payment required" }, REPORT_READY: { zh: "报告待付款交付", en: "Ready after payment" },
    PAID: { zh: "已付款", en: "Paid" }, SETTLEMENT_PENDING: { zh: "结算中", en: "Settling" }, DELIVERED: { zh: "已交付", en: "Delivered" },
  }, state, locale, { zh: "处理中", en: "Processing" });
}

/** 交易日 "2026-09-21" → 「2026年9月21日」/「Sep 21, 2026」（日期本身，不做时区换算）；非法给 null */
export function tradingDateText(date: string | null | undefined, locale: Locale): string | null {
  const m = date ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(date) : null;
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12));
  return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", { year: "numeric", month: locale === "zh" ? "long" : "short", day: "numeric", timeZone: "UTC" }).format(d);
}

/** 基点 → 百分比文字：-4 → "-0.04%"；null → null（不补 0） */
export function bpsPercent(bps: number | null | undefined, signed = true): string | null {
  if (bps === null || bps === undefined || !Number.isFinite(bps)) return null;
  const s = (bps / 100).toFixed(2);
  return `${signed && bps > 0 ? "+" : ""}${s}%`;
}

/** 报告版本：缺值给 null（页面显示「—」并注明未返回），不编出 v1 */
export function reportVersionText(version: number | null | undefined): string | null {
  return typeof version === "number" && Number.isFinite(version) ? `v${version}` : null;
}

/** 区块确认数：任一缺值写「确认数未返回」，不补 0 */
export function confirmationsText(got: number | null | undefined, need: number | null | undefined, locale: Locale): string {
  const ok = (n: number | null | undefined): n is number => typeof n === "number" && Number.isFinite(n);
  if (!ok(got) || !ok(need)) return locale === "zh" ? "确认数未返回" : "Confirmations not returned";
  return locale === "zh" ? `已确认 ${got} / ${need} 个区块` : `${got} / ${need} confirmations`;
}
