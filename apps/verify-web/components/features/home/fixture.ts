/**
 * 首页「产品画面」用的示例任务（FIXTURE）。全部写死，不请求接口；每一块都带 mode: "FIXTURE"，
 * 页面上用 ModeTag 显示「示例数据」，绝不渲染成实时（R-03）。
 * 情节沿用 v6 首页示例：五个交易日内按 CPI 与利率预期在 AAPLx / NVDAx 间分配预算。
 * 只有链上确认才算成交；「已决定 / 已签发」不写成成交。
 */
import type { Locale } from "@/lib/i18n";
import type { StepState } from "@/components/kit/StepFlow";

export const FIXTURE_MODE = "FIXTURE" as const;

type L = Record<Locale, string>;

export interface FixtureTask {
  mode: typeof FIXTURE_MODE;
  id: string;
  title: L;
  status: "running";
  kpis: ReadonlyArray<{ key: string; label: L; amount?: { raw: string; decimals: number; symbol: string }; count?: number; unit?: L }>;
  agentSays: { mode: typeof FIXTURE_MODE; text: L; sources: readonly L[] };
  steps: ReadonlyArray<{ mode: typeof FIXTURE_MODE; state: StepState; title: L; note?: L }>;
  /** hash 只做列表 key；首页不展示编号与复制按钮（示例编号对访客没有用处，10/5 走查） */
  evidence: ReadonlyArray<{ mode: typeof FIXTURE_MODE; source: L; at: string; hash: string; price?: string }>;
}

export const FIXTURE_TASK: FixtureTask = {
  mode: FIXTURE_MODE,
  id: "tsk_example_cpi_rates",
  title: {
    zh: "五个交易日内，按 CPI 与利率预期在 AAPLx / NVDAx 间分配预算",
    en: "Over five trading days, split the budget across AAPLx / NVDAx by CPI and rate expectations",
  },
  status: "running",
  kpis: [
    { key: "scope", label: { zh: "签过的范围", en: "Signed scope" }, amount: { raw: "100000000", decimals: 6, symbol: "USDG" } },
    { key: "spent", label: { zh: "已花出", en: "Spent" }, amount: { raw: "25000000", decimals: 6, symbol: "USDG" } },
    { key: "fills", label: { zh: "已成交", en: "Filled" }, count: 1, unit: { zh: "笔", en: "fill" } },
    { key: "left", label: { zh: "还计划", en: "Still planned" }, count: 4, unit: { zh: "笔", en: "tranches" } },
  ],
  agentSays: {
    mode: FIXTURE_MODE,
    text: {
      zh: "利率预期上移，我修订了计划：剩余预算分四笔，隔两个交易日一笔，下一笔减半。",
      en: "Rate expectations moved up, so I revised the plan: four tranches left, two trading days apart, with the next one halved.",
    },
    sources: [{ zh: "CPI 实际值", en: "CPI print" }, { zh: "利率预期", en: "Rate expectations" }],
  },
  steps: [
    { mode: FIXTURE_MODE, state: "done", title: { zh: "第 1 轮 · CPI 前持币，等实际值", en: "Turn 1 · Hold cash before CPI, wait for the print" } },
    { mode: FIXTURE_MODE, state: "done", title: { zh: "第 2 轮 · CPI 温和，买入 AAPLx 一笔", en: "Turn 2 · CPI benign, buy one tranche of AAPLx" } },
    { mode: FIXTURE_MODE, state: "active", title: { zh: "第 3 轮 · 利率预期上移，下一笔减半", en: "Turn 3 · Rates up, halve the next tranche" } },
    { mode: FIXTURE_MODE, state: "idle", title: { zh: "第 4 轮 · 按修订后的计划继续", en: "Turn 4 · Continue on the revised plan" } },
  ],
  evidence: [
    { mode: FIXTURE_MODE, source: { zh: "宏观数据 · CPI 实际值", en: "Macro data · CPI print" }, at: "2026-09-10T12:30:00Z", hash: "ev_example_cpi_0910" },
    { mode: FIXTURE_MODE, source: { zh: "链上报价 · AAPLx 聚合报价", en: "On-chain quote · AAPLx aggregator" }, at: "2026-09-10T14:02:00Z", hash: "ev_example_quote_0910", price: "231.40" },
    { mode: FIXTURE_MODE, source: { zh: "成交回执 · AAPLx 买入", en: "Fill receipt · AAPLx buy" }, at: "2026-09-10T14:03:00Z", hash: "ev_example_fill_0910" },
  ],
};
