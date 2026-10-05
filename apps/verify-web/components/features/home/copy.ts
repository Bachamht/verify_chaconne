/**
 * v8 首页文案（方案 §5.1）。沿用 v7 首页的核心信息与用词（app/HomeLegacy.tsx 的 V7_COPY / COPY）。
 * 规则：中文不夹英文标语、不用破折号；签名不是交易；观察不执行交易；不承诺「失败交易不花钱」之类的结果。
 * 纯数据，不引 React，便于单测。
 */
import type { Locale } from "@/lib/i18n";

/** PlanGuard v2（委托合约，与 /developers 地址表一致） */
export const PLANGUARD = "0xE8517f296211F4b9175796bAAB47979FB14Fd2F0";

export interface HomeCopy {
  overline: string;
  titleLead: string;
  titleEm: string;
  lead: string;
  ctaStart: string;
  ctaWorkspace: string;
  reassurance: readonly string[];
  speech: string;
  mascotAlt: string;
  stages: readonly string[];
  stageNote: string;
  integrationsLabel: string;
  integrations: ReadonlyArray<{ name: string; role: string }>;
  previewEyebrow: string;
  previewTitle: string;
  stepsTitle: string;
  stepsEyebrow: string;
  steps: ReadonlyArray<{ title: string; copy: string }>;
  trustTitle: string;
  trustEyebrow: string;
  trustLead: string;
  trust: ReadonlyArray<{ key: "evidence" | "certificate" | "contract"; title: string; copy: string; link?: { href: string; label: string } }>;
  contractName: string;
  devTitle: string;
  devCopy: string;
  devAction: string;
}

export const HOME_COPY: Record<Locale, HomeCopy> = {
  zh: {
    overline: "内置 Chaconne Agent · 链上美股交易",
    titleLead: "让 AI Agent，",
    titleEm: "按你的节奏交易。",
    lead: "告诉 Chaconne Agent 交易什么、预算多少。它替你研究，在你设定的边界内执行，并解释每一个决定。",
    ctaStart: "让 Agent 先跑给我看",
    ctaWorkspace: "已有任务？打开工作区",
    reassurance: ["无需自备 Agent", "先观察，不执行交易", "真实运行前逐项授权"],
    speech: "gm，先听你的安排。",
    mascotAlt: "Chaconne 紫色小指挥家",
    stages: ["研究", "判断", "执行"],
    stageNote: "研究有依据，执行有边界。",
    integrationsLabel: "从信息到链上执行",
    integrations: [
      { name: "OKX DEX", role: "报价与交易路线" },
      { name: "X Layer", role: "合约与链上结算" },
      { name: "OKX.AI", role: "Agent 服务入口" },
    ],
    previewEyebrow: "02 / 任务视角",
    previewTitle: "看见每一次判断。",
    stepsTitle: "三步开始",
    stepsEyebrow: "03 / 从目标开始",
    steps: [
      { title: "交代", copy: "选资产、预算和期限，示例策略可以自由改。" },
      { title: "观察", copy: "Agent 研究并写下决定，观察不执行交易；每个钱包每天最多 3 个观察任务。" },
      { title: "授权", copy: "确认买卖范围、额度与费用，再决定是否签名。" },
    ],
    trustTitle: "Agent 做判断，合约守边界。",
    trustEyebrow: "04 / 有据可查",
    trustLead: "你签署买卖范围与额度，平台执行器在这些边界内提交交易。暂停、撤销与收回额度各有不同作用，任务台会列出需要你处理的事项。",
    trust: [
      { key: "evidence", title: "证据", copy: "每次判断都记下来源、时间与数据模式，证据包可以离线复核。", link: { href: "/verify-bundle", label: "复核证据包" } },
      { key: "certificate", title: "证书", copy: "每笔交易先过核验才签证书；证书短时有效，过期必须重新核验。", link: { href: "/developers", label: "核验与证书说明" } },
      { key: "contract", title: "合约", copy: "合约检查金额、最少到账、收款人、路由和期限，超出你签下的范围就拒绝。" },
    ],
    contractName: "PlanGuard",
    devTitle: "已经有自己的 Agent？",
    devCopy: "通过 MCP、SDK 或 HTTP 接入，获取结构化判定、原因码与可离线复核的证据包。",
    devAction: "查看 Agent 接入文档",
  },
  en: {
    overline: "Built-in Chaconne Agent · Tokenized stocks",
    titleLead: "Let AI agents trade",
    titleEm: "to your tempo.",
    lead: "Tell Chaconne Agent what to trade and your budget. It researches, executes within your limits, and explains every decision.",
    ctaStart: "Let the agent show me",
    ctaWorkspace: "Have a task? Open the workspace",
    reassurance: ["No agent setup", "Observe without trading", "Authorize before going live"],
    speech: "gm. Your cue first.",
    mascotAlt: "Chaconne's purple conductor",
    stages: ["Research", "Judgment", "Execution"],
    stageNote: "Research with evidence. Execute within scope.",
    integrationsLabel: "From information to execution",
    integrations: [
      { name: "OKX DEX", role: "Quotes & trade routes" },
      { name: "X Layer", role: "Contracts & settlement" },
      { name: "OKX.AI", role: "Agent service discovery" },
    ],
    previewEyebrow: "02 / Inside a task",
    previewTitle: "See the thinking behind the trade.",
    stepsTitle: "Three steps to start",
    stepsEyebrow: "03 / Start with a goal",
    steps: [
      { title: "Set the goal", copy: "Choose assets, budget and expiry. Edit an example strategy freely." },
      { title: "Observe", copy: "The agent researches and records decisions. Observation executes no trades; up to 3 observation tasks per wallet per day." },
      { title: "Authorize", copy: "Review trade scope, allowances and fees before you decide to sign." },
    ],
    trustTitle: "The agent decides. The contract sets limits.",
    trustEyebrow: "04 / A record at every step",
    trustLead: "You sign the trade scope and allowances. The platform executor submits trades within those limits. Pausing, revoking and reclaiming allowances have different effects; the task desk shows what needs your attention.",
    trust: [
      { key: "evidence", title: "Evidence", copy: "Every decision records its sources, times and data mode. Evidence bundles can be re-checked offline.", link: { href: "/verify-bundle", label: "Check an evidence bundle" } },
      { key: "certificate", title: "Certificates", copy: "Each trade is verified before a certificate is signed. Certificates are short-lived; expired ones need a new check.", link: { href: "/developers", label: "Verification and certificates" } },
      { key: "contract", title: "Contract", copy: "The contract checks amount, minimum output, recipient, route and deadline, and rejects anything outside the scope you signed." },
    ],
    contractName: "PlanGuard",
    devTitle: "Already have your own agent?",
    devCopy: "Connect through MCP, the SDK or HTTP. Get structured verdicts, reason codes and evidence bundles that can be checked offline.",
    devAction: "Read the agent integration docs",
  },
};
