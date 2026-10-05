/** 工具页（/new、/plan、/tasks/[id]）v8 文案：中英各一份、不用破折号、按钮说后果。纯数据，单测检查键对齐。 */
import type { Locale } from "@/lib/i18n";

const ZH = {
  whyOwner: "先填写或连接资金钱包",
  whyOwnerInvalid: "先修正钱包地址",
  whyAssets: "先选资产",
  whyInputs: "至少选一个资金币种",
  whyBudget: "填一个有效的金额",
  whyWallet: "连接这个规划的所有者钱包才能签署",
  whyNotDeployed: "PlanGuard 还没有部署到本网络，暂时不能签署授权",
  rowNoAsset: (n: number) => `第 ${n} 行还没选资产`,
  weightsSum: (x: string) => `权重合计 ${x}%，需要正好 100%`,
  amountInvalid: "填一个正数，例如 10 或 12.5",
  stepGtBudget: "单步上限不能超过预算上限",
  notEnabled: "未开放",
  usingConnected: "正在用已连接的钱包",
  connect: "连接钱包",
  remix: (who: string) => `复用自 ${who}：模板只预填资产、策略与限额，不带金额、钱包、旧报价或旧授权。`,
  prefilled: "已从主站预填。确认金额与策略后再创建。",
  setupFailed: "资产、策略或模板没有完整加载。重试即可，已填的内容会保留。",
  retry: "重新加载",
  maxStepsInvalid: "最多步数填 1 到 50 之间的整数",
  submitCrashed: "没有提交：表单里有值无法处理（比如截止时间不是有效日期）。检查后再试，什么都没有发生。",
  acceptCrashed: "没有转成单笔核验：这一步在页面上出错了。刷新后再试，什么都没有发生。",
  stepWouldRevert: "模拟执行会失败，没有发送任何交易。常见原因是步骤证明已过期、报价变化或额度不足；稍后重新执行这一步。",
};
type Copy = typeof ZH;
const EN: Copy = {
  whyOwner: "Enter or connect the funding wallet first",
  whyOwnerInvalid: "Fix the wallet address first",
  whyAssets: "Pick the assets first",
  whyInputs: "Pick at least one funding currency",
  whyBudget: "Enter a valid amount",
  whyWallet: "Connect the wallet that owns this plan to sign",
  whyNotDeployed: "PlanGuard is not deployed on this network yet, so authorization is unavailable",
  rowNoAsset: (n: number) => `Row ${n} has no asset selected`,
  weightsSum: (x: string) => `Weights total ${x}%; they must add up to 100%`,
  amountInvalid: "Enter a positive number, e.g. 10 or 12.5",
  stepGtBudget: "The per-step cap cannot exceed the budget cap",
  notEnabled: "not enabled",
  usingConnected: "Using the connected wallet",
  connect: "Connect wallet",
  remix: (who: string) => `Reused from ${who}: the template prefills assets, policy and limits only, never amounts, wallets, old quotes or authorizations.`,
  prefilled: "Prefilled from the main site. Check the amount and policy before creating.",
  setupFailed: "Assets, policies or the template did not fully load. Retry; your edits are kept.",
  retry: "Retry",
  maxStepsInvalid: "Max steps must be a whole number from 1 to 50",
  submitCrashed: "Not submitted: a value in the form could not be processed (for example the deadline is not a valid date). Check it and retry; nothing happened.",
  acceptCrashed: "Not converted to a single check: this step failed in the page. Refresh and retry; nothing happened.",
  stepWouldRevert: "The step would revert in simulation, so nothing was sent. Usually the step certificate expired, the quote moved or the allowance is short; run the step again shortly.",
};

export function toolsCopy(locale: Locale): Copy {
  return locale === "zh" ? ZH : EN;
}

/** 规划候选的下一步（PlanNextStep）→ 短标签 + 色调 */
export const NEXT_STEP: Record<string, { zh: string; en: string; tone: "ok" | "warn" | "bad" | "info" }> = {
  READY: { zh: "可执行", en: "Ready", tone: "ok" },
  ACCEPT_PARTIAL: { zh: "只能部分完成", en: "Partial only", tone: "warn" },
  SWITCH_INPUT: { zh: "换资金币种", en: "Switch currency", tone: "warn" },
  WAIT_CONDITION: { zh: "等待条件", en: "Wait for a condition", tone: "info" },
  PROVIDE_DATA: { zh: "缺数据", en: "Data missing", tone: "info" },
  USER_MUST_RELAX_LIMIT: { zh: "你的上限拦住了", en: "Your limit blocks it", tone: "bad" },
};

/** 授权任务（mandate）状态与每次评估状态 → 界面文字（原始枚举只进 title） */
export const MANDATE_EVAL: Record<string, { zh: string; en: string; tone: "ok" | "warn" | "bad" | "info" }> = {
  READY: { zh: "可执行", en: "Ready", tone: "ok" },
  WAIT: { zh: "等待", en: "Waiting", tone: "info" },
  BLOCKED: { zh: "被拦住", en: "Blocked", tone: "bad" },
  DONE: { zh: "已完成", en: "Done", tone: "ok" },
};
