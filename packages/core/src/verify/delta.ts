/**
 * delta 解释器（v5 W2）：两次报告之间"什么变了"，纯函数，人话双语。
 */
import type { DeltaExplanation, ReasonCode, VerifyReport } from "./contracts";

const CODE_TEXT: Partial<Record<ReasonCode, { en: string; zh: string }>> = {
  MARKET_OUTSIDE_REGULAR: { en: "market outside regular hours", zh: "不在美股常规时段" },
  REFERENCE_STALE: { en: "reference price stale", zh: "参考价过期" },
  REFERENCE_MISSING: { en: "reference price missing", zh: "缺参考价" },
  QUOTE_TOO_OLD: { en: "quote too old", zh: "报价过期" },
  QUOTE_UNAVAILABLE: { en: "no quote", zh: "拿不到报价" },
  PRICE_IMPACT_EXCEEDED: { en: "price impact over limit", zh: "价格冲击超限" },
  PRICE_IMPACT_UNKNOWN: { en: "price impact unknown", zh: "价格冲击未知" },
  REFERENCE_DEVIATION_EXCEEDED: { en: "deviation vs reference over limit", zh: "相对参考价偏差超限" },
  CLOSE_SESSION_MISMATCH: { en: "close is not the latest session", zh: "收盘不是最近一个交易日" },
  UNIT_CHANGED: { en: "token unit multiplier changed", zh: "代币乘数变了" },
  CLOSE_UNCONFIRMED: { en: "close from 16:00 last trade, unconfirmed", zh: "收盘来自 16:00 最后成交，未经次日确认" },
  TOKEN_UNIT_UNVERIFIED: { en: "token unit unverified", zh: "代币单位未核验" },
  USD_CONVERSION_UNKNOWN: { en: "stablecoin USD value unknown", zh: "稳定币美元计价未知" },
  SOURCE_CONFLICT: { en: "sources conflict", zh: "来源冲突" },
  REFERENCE_PROVISIONAL: { en: "reference not accepted by policy", zh: "参考价不被策略接受" },
};
const codeText = (c: ReasonCode) => CODE_TEXT[c] ?? { en: c, zh: c };

function unitOf(r: VerifyReport): string | null {
  const u = r.reasons.find((x) => x.code === "UNIT_CHANGED")?.detail;
  return typeof u?.["to"] === "string" ? (u["to"] as string) : null;
}

export function explainDelta(prev: VerifyReport | null, next: VerifyReport): DeltaExplanation {
  const prevCodes = new Set<ReasonCode>((prev?.reasons ?? []).filter((r) => r.severity !== "info").map((r) => r.code));
  const nextCodes = new Set<ReasonCode>(next.reasons.filter((r) => r.severity !== "info").map((r) => r.code));
  const addedReasons = [...nextCodes].filter((c) => !prevCodes.has(c)).sort();
  const removedReasons = [...prevCodes].filter((c) => !nextCodes.has(c)).sort();
  const pImp = prev?.normalizedQuote?.adverseImpactBps ?? null;
  const nImp = next.normalizedQuote?.adverseImpactBps ?? null;
  const pDev = prev?.reference?.deviationBps ?? null;
  const nDev = next.reference?.deviationBps ?? null;
  const impactBpsChange = prev && pImp !== nImp ? { from: pImp, to: nImp } : null;
  const deviationBpsChange = prev && pDev !== nDev ? { from: pDev, to: nDev } : null;
  const sessionChange = prev && prev.marketSession !== next.marketSession ? { from: prev.marketSession, to: next.marketSession } : null;
  const pUnit = prev ? unitOf(prev) : null;
  const nUnit = unitOf(next);
  const unitChange = nUnit !== null && nUnit !== pUnit ? { from: pUnit, to: nUnit } : null;

  const en: string[] = [];
  const zh: string[] = [];
  if (!prev) {
    en.push(`First evaluation: ${next.verdict}.`);
    zh.push(`首次评估：${next.verdict}。`);
  } else if (prev.verdict !== next.verdict) {
    en.push(`Verdict changed ${prev.verdict} → ${next.verdict}.`);
    zh.push(`判定从 ${prev.verdict} 变为 ${next.verdict}。`);
  } else {
    en.push(`Verdict unchanged (${next.verdict}).`);
    zh.push(`判定不变（${next.verdict}）。`);
  }
  if (sessionChange) {
    en.push(`Session ${sessionChange.from} → ${sessionChange.to}.`);
    zh.push(`时段 ${sessionChange.from} → ${sessionChange.to}。`);
  }
  if (removedReasons.length) {
    en.push(`Cleared: ${removedReasons.map((c) => codeText(c).en).join(", ")}.`);
    zh.push(`已解除：${removedReasons.map((c) => codeText(c).zh).join("、")}。`);
  }
  if (addedReasons.length) {
    en.push(`New: ${addedReasons.map((c) => codeText(c).en).join(", ")}.`);
    zh.push(`新出现：${addedReasons.map((c) => codeText(c).zh).join("、")}。`);
  }
  if (impactBpsChange) {
    en.push(`Price impact ${fmt(impactBpsChange.from)} → ${fmt(impactBpsChange.to)} bps.`);
    zh.push(`价格冲击 ${fmt(impactBpsChange.from)} → ${fmt(impactBpsChange.to)} bps。`);
  }
  if (deviationBpsChange) {
    en.push(`Deviation vs reference ${fmt(deviationBpsChange.from)} → ${fmt(deviationBpsChange.to)} bps.`);
    zh.push(`相对参考价偏差 ${fmt(deviationBpsChange.from)} → ${fmt(deviationBpsChange.to)} bps。`);
  }
  if (unitChange) {
    en.push(`Token multiplier ${unitChange.from ?? "?"} → ${unitChange.to}: re-plan before executing.`);
    zh.push(`代币乘数 ${unitChange.from ?? "?"} → ${unitChange.to}：执行前需重新规划。`);
  }
  const nextStep = next.verdict === "eligible" ? { en: "Next: ready to execute a step.", zh: "下一步：可以执行一步。" } : addedReasons.some((c) => ["MARKET_OUTSIDE_REGULAR", "REFERENCE_STALE", "QUOTE_TOO_OLD"].includes(c)) || nextCodes.has("MARKET_OUTSIDE_REGULAR") ? { en: "Next: wait for the condition to change.", zh: "下一步：等待条件变化。" } : { en: "Next: no action; see reasons.", zh: "下一步：暂不行动，见原因。" };
  en.push(nextStep.en);
  zh.push(nextStep.zh);
  return { addedReasons, removedReasons, impactBpsChange, deviationBpsChange, sessionChange, unitChange, summary: { en: en.join(" "), zh: zh.join("") } };
}

function fmt(v: number | null): string {
  return v === null ? "unknown" : String(v);
}
