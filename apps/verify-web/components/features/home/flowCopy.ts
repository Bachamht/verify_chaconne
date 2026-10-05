/**
 * 首页「怎么运作」示意动画的文案（纯数据，单测见 test/v8HomeFlow.test.ts）。
 * 画面为主、字为辅：标题一句、说明一句，画面上只有站名与几个短标签；完整的文字描述给读屏（figcaption）。
 * 规则同首页 copy.ts：中文不用破折号；只写代码里成立的事（核验不签越界的提案；额度只授权给 PlanGuard，
 * 它按你签的范围放行、这时才从你的钱包划出资金；成交的代币回到你的钱包）。
 */
import type { Locale } from "@/lib/i18n";
import type { TagKey } from "./scoreScene";

export const FLOW_TAGS: readonly TagKey[] = ["agent", "scope", "verify", "guard", "dex", "wallet", "allowance"];
/** 一笔交易依次经过的四站（编号与 hero 下方「01 研究」同一种排法） */
export const FLOW_STEPS: Readonly<Partial<Record<TagKey, string>>> = { verify: "01", guard: "02", dex: "03", wallet: "04" };
export type LegendKey = "note" | "coin" | "token" | "rogue";
export const LEGEND: readonly LegendKey[] = ["note", "coin", "token", "rogue"];

export interface FlowCopy {
  eyebrow: string;
  title: string;
  lead: string;
  /** 读屏用的画面描述（画面本身 aria-hidden） */
  summary: string;
  /** 卡片顶栏：标题 + 「示意」 */
  bar: string;
  note: string;
  legend: Record<LegendKey, string>;
  tags: Record<TagKey, string>;
  /** 越界的提案在 PlanGuard 停下时，旁边出现的字 */
  blocked: string;
  pause: string;
  play: string;
}

export const FLOW_COPY: Record<Locale, FlowCopy> = {
  zh: {
    eyebrow: "01 / 怎么运作",
    title: "Agent 只按你签的谱演奏。",
    lead: "你签下的范围就是乐谱。额度只授权给 PlanGuard 合约：每一笔先过核验，合约按谱放行，越界的直接拦下。",
    summary: "示意动画：Chaconne Agent 发出的每一笔提案都沿着你签下的范围前进。提案先经过核验，再到 PlanGuard 合约；合约这时才凭额度从你的钱包划出资金，经 OKX DEX 换成股票代币，代币回到你的钱包。超出范围的提案在 PlanGuard 被拦下，不会动用你的资金。",
    bar: "一笔交易的路径",
    note: "示意",
    legend: { note: "Agent 提案", coin: "你的资金", token: "买到的代币", rogue: "越界提案" },
    tags: { agent: "Chaconne Agent", scope: "你签下的范围", verify: "核验", guard: "PlanGuard 合约", dex: "OKX DEX", wallet: "你的钱包", allowance: "额度" },
    blocked: "拦下",
    pause: "暂停动画",
    play: "播放动画",
  },
  en: {
    eyebrow: "01 / How it works",
    title: "The agent plays only the score you sign.",
    lead: "The scope you sign is the score. Your allowance goes only to the PlanGuard contract: every trade is verified first, PlanGuard releases what is on the score, and anything off it is stopped.",
    summary: "Illustration: every proposal from Chaconne Agent travels within the scope you signed. It is verified first, then reaches the PlanGuard contract; only then does the contract use your allowance to draw funds from your wallet, swap them on OKX DEX for a stock token, and send the token back to your wallet. A proposal outside the scope is stopped at PlanGuard and never touches your funds.",
    bar: "The path of one trade",
    note: "Illustration",
    legend: { note: "Agent proposal", coin: "Your funds", token: "Token bought", rogue: "Out of scope" },
    tags: { agent: "Chaconne Agent", scope: "Your signed scope", verify: "Verify", guard: "PlanGuard contract", dex: "OKX DEX", wallet: "Your wallet", allowance: "Allowance" },
    blocked: "Blocked",
    pause: "Pause animation",
    play: "Play animation",
  },
};
