/**
 * 任务表单文案（中英各自纯净：中文不夹英文标语、不用破折号）。/start 与 /agent/new 共用。
 */
import type { Locale } from "@/lib/i18n";

const C = {
  template: { zh: "从一个模板开始", en: "Start from a template" },
  template_hint: { zh: "模板只提供目标和策略的写法，不代表收益承诺。选了之后都可以改。", en: "Templates only suggest an objective and strategy, not a promise of returns. Edit anything after picking one." },
  objective: { zh: "目标", en: "Objective" },
  objective_hint: { zh: "你希望 Agent 在这段时间里完成什么。具体做法可以写在下面的「策略细节与交易时段」里。", en: "What the agent should accomplish over this period. Put the detailed approach under Strategy details and trading hours below." },
  assets: { zh: "允许交易的股票", en: "Stocks it may trade" },
  assets_hint: { zh: "最多 8 只。Agent 只能在这些股票里做决定。", en: "Up to 8. The agent only decides among these." },
  assets_pick: { zh: "选择股票", en: "Choose stocks" },
  assets_search: { zh: "搜索代码或公司", en: "Search ticker or company" },
  assets_none: { zh: "没有匹配的股票", en: "No matching stocks" },
  assets_selected: { zh: "已选", en: "Selected" },
  assets_remove: { zh: "移除", en: "Remove" },
  assets_full: { zh: "已选满 8 只，先移除一只再加。", en: "8 selected. Remove one before adding another." },
  input_asset: { zh: "资金币种", en: "Pay with" },
  input_asset_hint: { zh: "预算和每笔金额都用这个币种计算。", en: "Budget and per-trade amounts are in this currency." },
  limits: { zh: "交易范围", en: "Trading scope" },
  limits_hint: { zh: "这些是你签名的内容：每一笔都必须同时满足。", en: "This is what you sign: every trade must satisfy all of it." },
  total: { zh: "总预算", en: "Total budget" },
  per: { zh: "单笔上限", en: "Per-trade cap" },
  steps: { zh: "最多成交笔数", en: "Maximum fills" },
  days: { zh: "有效天数", en: "Days valid" },
  direction: { zh: "方向", en: "Direction" },
  buy_only: { zh: "默认只买入", en: "Buy only by default" },
  allow_sell: { zh: "同时允许 Agent 卖出", en: "Also allow the agent to sell" },
  allow_sell_hint: { zh: "卖出范围包含钱包里这些股票的原有持仓，不限于本任务买入的部分。授权时会逐只列出卖出上限，每只多签 2 次。", en: "Selling covers holdings of these stocks already in your wallet, not only what this task buys. Authorization lists each stock's sell limit and takes 2 more signatures per stock." },
  conditions: { zh: "策略细节与交易时段", en: "Strategy details and trading hours" },
  conditions_hint: { zh: "策略告诉 Agent 怎么思考；每笔交易仍须符合你确认的预算、股票和授权范围。", en: "The strategy guides how the agent reasons. Every trade must still fit the budget, stocks and scope you confirm." },
  strategy: { zh: "策略（签名之外，可随时改）", en: "Strategy (outside the signature, editable any time)" },
  regular: { zh: "只在美股常规时段交易", en: "Trade only during US regular hours" },
  regular_hint: { zh: "勾选后写进签名范围，盘前盘后不会成交。", en: "Written into the signed scope; nothing fills outside regular hours." },
  fix_fields: { zh: "有几项需要修改，见各字段下方的说明。", en: "A few fields need attention; see the notes under each field." },
} as const;

export type TaskFormKey = keyof typeof C;
export function tf(locale: Locale, k: TaskFormKey): string {
  return C[k][locale];
}

/** 字段错误码 → 人话（本地校验；服务端的码走 lib/errors fieldErrorText） */
const ERR: Record<string, { zh: string; en: string }> = {
  objective: { zh: "写下你希望 Agent 完成的目标。", en: "Describe what the agent should do." },
  assets: { zh: "选择 1 到 8 只可交易的股票。", en: "Choose 1 to 8 tradable stocks." },
  unavailable: { zh: "有股票当前不可交易，请移除后重新选择。", en: "Some stocks are no longer tradable. Remove them and choose again." },
  inputAsset: { zh: "选择一个资金币种。", en: "Choose a currency to pay with." },
  total: { zh: "总预算需大于 0，且小数位不超过币种精度。", en: "Enter a positive budget within the token's precision." },
  perStep: { zh: "单笔上限需大于 0，且不能超过总预算。", en: "Each trade must be positive and no larger than the total budget." },
  maxSteps: { zh: "成交笔数需为 1 到 60 的整数。", en: "Use a whole number from 1 to 60." },
  days: { zh: "有效天数需为 1 到 365。", en: "Use 1 to 365 days." },
};
export function fieldErrorCopy(code: string, locale: Locale): string {
  return ERR[code]?.[locale] ?? code;
}
