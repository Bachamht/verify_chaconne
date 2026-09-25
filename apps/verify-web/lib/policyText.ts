/** 每一步交易前的核验策略 → 一句人话（任务详情 / 引导页计划卡共用）。策略与限额来自任务 params，即工具箱同一套核验引擎的参数。 */
import type { Locale } from "./i18n";

export function policySentence(params: Record<string, unknown> | null | undefined, locale: Locale): string {
  const zh = locale === "zh";
  const id = typeof params?.["policyId"] === "string" ? (params["policyId"] as string) : "STRICT_LIVE";
  const impact = typeof params?.["maxPriceImpactBps"] === "number" ? (params["maxPriceImpactBps"] as number) : 100;
  const impactText = zh ? `价格冲击上限 ${impact / 100}%` : `max price impact ${impact / 100}%`;
  const policy = id === "QUOTE_ONLY"
    ? (zh ? "只核对路由、报价与价格冲击，24 小时可执行" : "checks route, quote and price impact only; executes any hour")
    : id === "REFERENCE_CONTEXT"
      ? (zh ? "另比对最近收盘价，偏离过大则不买" : "also compares with the latest close and skips if it deviates too much")
      : (zh ? "要求实时参考价，只在美股常规时段" : "requires a live reference, US regular hours only");
  return `${policy}；${impactText}`;
}
