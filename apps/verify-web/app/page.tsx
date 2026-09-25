"use client";

import Image from "next/image";
import Link from "next/link";
import { ArrowRight, ArrowUpRight, Braces, Check, ChevronDown, Clock3, Pause, Route, ShieldCheck, Sparkles } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import "./home.css";

/** New visitors start with a simulation; existing workflows remain directly reachable below. */
const COPY = {
  zh: {
    overline: "AI AGENT · 链上美股交易",
    titleLead: "让 AI Agent，", titleEm: "按你的节奏交易。",
    lead: "把链上美股买入计划交给 AI Agent。",
    leadStrong: "你定预算和条件，它负责判断与等待。",
    leadEnd: "先体验，再决定是否授权真实交易。",
    ctaTry: "免费体验一个任务", ctaAgent: "进入 Agent 工作区",
    reassurance: ["无需钱包", "无需自备 Agent", "不使用真实资金"],
    speech: "gm，先排个计划。", character: "Chaconne 紫色小指挥家",
    exampleHeading: "AGENT 的计划", exampleTag: "预设示例 · 非实时",
    exampleAsset: "苹果链上股票 · 分 3 次买入", exampleBudget: "示例总预算",
    exampleBeats: ["第 1 次 · 10 USDG", "第 2 次", "第 3 次"],
    exampleStatus: "示例：等待交易时段", exampleReason: "额度留着，条件到了再检查。",
    pathLabel: "第一次体验，三步开始",
    path: [
      { title: "选一个计划", copy: "从简单模板开始。" },
      { title: "看看 Agent 怎么做", copy: "行动或等待，都有理由。" },
      { title: "决定是否运行", copy: "真实资金，最后才授权。" },
    ],
    workspaceLabel: "继续你的计划", workspaceTitle: "已经有任务？接着上次的节奏。",
    workspaceCopy: "查看任务进度、调整条件，或了解为什么还在等待。",
    workspaceAction: "查看我的任务", workspaceAdvanced: "打开完整工作区",
    toolsLabel: "更多方式，按需使用", toolsTitle: "需要的工具，都在这里。",
    toolsCopy: "从单笔核验到任务诊断，随时进入完整功能。",
    groups: [
      { title: "管理 Agent 任务", links: [
        { href: "/agent", label: "Agent 工作区", detail: "创建任务、检查影响、选择任务草案" },
        { href: "/agent/tasks", label: "我的任务", detail: "进度、授权与执行状态" },
        { href: "/agent/events", label: "事件日历", detail: "查看宏观事件与公司财报排期" },
        { href: "/agent/funds", label: "持仓与资金", detail: "查看持仓、余额与预算分组" },
        { href: "/agent/journal", label: "任务日志", detail: "回顾 Agent 做过的判断和动作" },
      ] },
      { title: "规划与实验", links: [
        { href: "/new", label: "单笔交易核验", detail: "手动配置金额、策略和交易边界" },
        { href: "/plan", label: "交易规划", detail: "比较资产与预算，规划买入方案" },
        { href: "/play", label: "角色试玩", detail: "选择角色，体验预设模拟题目" },
        { href: "/agent/lab", label: "任务实验室", detail: "诊断等待、比较方案、回放条件" },
      ] },
      { title: "证据与记录", links: [
        { href: "/verify-bundle", label: "验证证据包", detail: "独立检查已有的核验证据" },
        { href: "/replay/AAPLx", label: "市场回放", detail: "从 AAPLx 开始回看历史证据" },
        { href: "/live", label: "公开核验板", detail: "浏览公开的核验记录" },
        { href: "/me", label: "本机核验记录", detail: "找回这台设备上的单笔核验" },
      ] },
    ],
    protectionLabel: "每次交易之前", protectionTitle: "Agent 做判断，合约守边界。",
    protectionCopy: "真实运行需要钱包授权和执行者。每笔交易还要经过核验，并受你签署的金额、收款人和期限等约束。",
    protectionMore: "了解核验与执行机制",
    riskLabel: "核验在检查什么", riskTitle: "先看证据，\n再决定是否行动。",
    riskIntro: "名字、价格和交易计划都需要确认。核验帮助 Agent 看见推理之外的限制。",
    risks: [
      { name: "STALE", title: "价格是否还有效？", detail: "核验区分数据的源时间和接收时间，检查参考价与报价是否过期。一个数字不等于一份新鲜证据。", annotation: "源时间 ≠ 接收时间" },
      { name: "IMPOSTOR", title: "代币是否对得上？", detail: "链上同名代币可能有不同合约。核验检查代币的链上身份和名录登记，不能只认名称与符号。", annotation: "名字不是身份" },
      { name: "DRIFT", title: "成交条件是否变了？", detail: "从决定到成交，价格、路由和报价期限都可能变化。执行前仍要满足证书和合约要求。", annotation: "决定 ≠ 成交" },
    ],
    processLabel: "从判断到执行", processTitle: "三道关卡，\n各自负责。",
    processCopy: "每一步都有明确的检查范围；条件不满足时，等待或拒绝也会给出原因。",
    steps: [
      { title: "核验：查看证据与时间。", copy: "按所选策略检查链上可成交报价与路由、代币链上身份、OKX RWA 名录登记和股票参考价。结果分为可执行、有限制、拒绝，并附原因码。" },
      { title: "证书：短时有效，过期重新核验。", copy: "只有满足签发条件才生成证书，而且不会比它依据的报价活得更久。确切期限以返回证书为准；过期后必须重新核验。" },
      { title: "执行：Guard 合约检查交易边界。", copy: "花出金额、最少到账、收款人、路由、期限，都必须满足合约检查。未用完的输入按执行规则退回。" },
    ],
    policiesLabel: "高级核验仍可选择三种策略", policies: ["实时价格", "收盘参考", "仅核对报价"],
    developerLabel: "BRING YOUR OWN AGENT", developerTitle: "已经有自己的 Agent？",
    developerCopy: "通过 MCP、TypeScript SDK 或 HTTP 接入，获取结构化判定、原因码与可离线复验的证据包。",
    developerAction: "查看 Agent 接入文档",
    endnote: "有趣的外表。认真的证据。",
  },
  en: {
    overline: "AI AGENT · TOKENIZED US STOCKS",
    titleLead: "Let AI agents trade", titleEm: "to your tempo.",
    lead: "Give your tokenized stock plan to an AI agent.",
    leadStrong: "You set the budget and conditions. It checks when to act or wait.",
    leadEnd: "Try a simulation before authorizing real trades.",
    ctaTry: "Try a task for free", ctaAgent: "Open agent workspace",
    reassurance: ["No wallet needed", "No agent setup", "No real funds used"],
    speech: "gm. Let's make a plan.", character: "Chaconne's purple conductor",
    exampleHeading: "MY AGENT'S PLAN", exampleTag: "PRESET EXAMPLE · NOT LIVE",
    exampleAsset: "Tokenized Apple stock · 3 purchases", exampleBudget: "Example total budget",
    exampleBeats: ["Buy 1 · 10 USDG", "Buy 2", "Buy 3"],
    exampleStatus: "Example: waiting for market hours", exampleReason: "Keep the budget. Check again when conditions allow.",
    pathLabel: "Your first task in three steps",
    path: [
      { title: "Choose a plan", copy: "Start with a simple template." },
      { title: "See what the agent does", copy: "A reason to act. A reason to wait." },
      { title: "Decide whether to run it", copy: "Authorize real funds only at the end." },
    ],
    workspaceLabel: "PICK UP YOUR PLAN", workspaceTitle: "Already have a task? Keep the rhythm.",
    workspaceCopy: "Check its progress, adjust conditions, or find out why it is waiting.",
    workspaceAction: "View my tasks", workspaceAdvanced: "Open full workspace",
    toolsLabel: "MORE WAYS TO WORK", toolsTitle: "Your tools, when you need them.",
    toolsCopy: "From a single trade check to task diagnosis, all the full workflows are here.",
    groups: [
      { title: "Manage agent tasks", links: [
        { href: "/agent", label: "Agent workspace", detail: "Create tasks, check impact and explore drafts" },
        { href: "/agent/tasks", label: "My tasks", detail: "Progress, authorizations and execution status" },
        { href: "/agent/events", label: "Event calendar", detail: "Macro releases and company earnings" },
        { href: "/agent/funds", label: "Holdings and funds", detail: "Positions, balances and budget groups" },
        { href: "/agent/journal", label: "Task journal", detail: "Review the agent's decisions and actions" },
      ] },
      { title: "Plan and experiment", links: [
        { href: "/new", label: "Verify a trade", detail: "Set amounts, policies and trade boundaries" },
        { href: "/plan", label: "Trade planner", detail: "Compare assets and budgets for a purchase" },
        { href: "/play", label: "Character playground", detail: "Choose a character and a simulation scenario" },
        { href: "/agent/lab", label: "Task lab", detail: "Diagnose waits, compare plans and replay conditions" },
      ] },
      { title: "Evidence and history", links: [
        { href: "/verify-bundle", label: "Verify an evidence bundle", detail: "Independently check existing trade evidence" },
        { href: "/replay/AAPLx", label: "Market replay", detail: "Review historical evidence, starting with AAPLx" },
        { href: "/live", label: "Public verification board", detail: "Browse public verification records" },
        { href: "/me", label: "This device's verifications", detail: "Return to trade checks saved on this device" },
      ] },
    ],
    protectionLabel: "BEFORE EVERY TRADE", protectionTitle: "The agent decides. The contract sets limits.",
    protectionCopy: "Real execution needs wallet authorization and an executor. Each trade must pass verification and stay within the amounts, recipient, deadline and other boundaries you signed.",
    protectionMore: "Explore verification and execution",
    riskLabel: "WHAT VERIFICATION CHECKS", riskTitle: "Evidence first.\nAction second.",
    riskIntro: "Names, prices and trade plans all need checking. Verification makes constraints outside the model's reasoning visible.",
    risks: [
      { name: "STALE", title: "Is the price still valid?", detail: "Verification distinguishes source time from received time and checks whether reference prices and quotes have expired. A number alone is not fresh evidence.", annotation: "Source time ≠ received time" },
      { name: "IMPOSTOR", title: "Is this the right token?", detail: "Tokens with the same name can have different contracts. Verification checks on-chain identity and registry entries, beyond the name or symbol.", annotation: "A name is not an identity" },
      { name: "DRIFT", title: "Have trade conditions changed?", detail: "Between a decision and settlement, prices, routes and quote validity can change. Execution must still satisfy the certificate and contract checks.", annotation: "Decided ≠ settled" },
    ],
    processLabel: "FROM DECISION TO EXECUTION", processTitle: "Three gates.\nDistinct checks.",
    processCopy: "Each stage has a defined scope. If conditions fail, waiting or rejection comes with reasons.",
    steps: [
      { title: "Verify: inspect evidence and timestamps.", copy: "The selected policy checks the executable quote and route, token identity, OKX RWA registry entry and stock reference price. Verdicts are eligible, limited or rejected, with reason codes." },
      { title: "Certify: short validity, then verify again.", copy: "A certificate is issued only when its conditions pass, and never outlives the underlying quote. The returned certificate gives the exact deadline. Expired evidence needs a new check." },
      { title: "Execute: the Guard checks trade boundaries.", copy: "Amount in, minimum out, recipient, route and deadline must all pass the contract's checks. Unspent input is returned according to the execution rules." },
    ],
    policiesLabel: "Advanced verification offers three policies", policies: ["Live reference", "Closing reference", "Quote only"],
    developerLabel: "BRING YOUR OWN AGENT", developerTitle: "Already have your own agent?",
    developerCopy: "Connect through MCP, the TypeScript SDK or HTTP. Get structured verdicts, reason codes and evidence bundles that can be checked offline.",
    developerAction: "Read the agent integration docs",
    endnote: "Meme energy. Serious evidence.",
  },
};

const RISK_ICONS = [Clock3, Sparkles, Route];

export default function Home() {
  const { locale } = useI18n();
  const c = COPY[locale];
  return (
    <div className="verify-home" data-locale={locale}>
      <section className="verify-hero" aria-labelledby="verify-hero-title">
        <div className="verify-hero-copy">
          <p className="verify-overline"><span aria-hidden="true" />{c.overline}</p>
          <h1 id="verify-hero-title">{c.titleLead}<br /><em>{c.titleEm}</em></h1>
          <p className="verify-hero-lead">{c.lead}<br /><strong>{c.leadStrong}</strong><br />{c.leadEnd}</p>
          <Link href="/start" className="verify-primary">{c.ctaTry}<ArrowUpRight size={18} aria-hidden="true" /></Link>
          <ul className="verify-reassurance">{c.reassurance.map((item) => <li key={item}><Check size={12} aria-hidden="true" />{item}</li>)}</ul>
          <Link href="/agent" className="verify-text-link">{c.ctaAgent}<ArrowRight size={15} aria-hidden="true" /></Link>
        </div>
        <div className="verify-stage">
          <div className="verify-stage-art">
            <span className="verify-stage-meme">NO FOMO. JUST TEMPO.</span>
            <span className="verify-stage-orbit" aria-hidden="true" />
            <Image className="verify-stage-character" src="/brand/conductor-v1.jpg" alt={c.character} width={768} height={768} sizes="(max-width: 640px) 230px, 270px" priority unoptimized draggable={false} />
            <span className="verify-stage-speech">{c.speech}</span>
          </div>
          <article className="verify-example" aria-labelledby="verify-example-title">
            <div className="verify-example-head"><h2 id="verify-example-title">{c.exampleHeading}</h2><span>{c.exampleTag}</span></div>
            <div className="verify-example-body">
              <div className="verify-example-asset">
                <span className="verify-asset-avatar" aria-hidden="true">a</span>
                <div><h3>AAPLx</h3><p>{c.exampleAsset}</p></div>
                <div className="verify-example-budget"><strong>30 <span>USDG</span></strong><small>{c.exampleBudget}</small></div>
              </div>
              <div className="verify-beats" aria-hidden="true"><span /><span /><span /></div>
              <div className="verify-beat-labels">{c.exampleBeats.map((beat) => <span key={beat}>{beat}</span>)}</div>
            </div>
            <div className="verify-example-status"><Pause size={15} aria-hidden="true" /><p><strong>{c.exampleStatus}</strong><span>{c.exampleReason}</span></p></div>
          </article>
        </div>
      </section>

      <ol className="verify-path" aria-label={c.pathLabel}>
        {c.path.map((step, i) => <li key={step.title}><span className="verify-path-number" aria-hidden="true">0{i + 1}</span><div><h2>{step.title}</h2><p>{step.copy}</p></div></li>)}
      </ol>

      <section className="verify-return" aria-labelledby="verify-return-title">
        <div><p className="verify-overline">{c.workspaceLabel}</p><h2 id="verify-return-title">{c.workspaceTitle}</h2><p className="verify-return-copy">{c.workspaceCopy}</p></div>
        <div className="verify-return-actions"><Link className="verify-secondary" href="/agent/tasks">{c.workspaceAction}<ArrowUpRight size={17} aria-hidden="true" /></Link><Link className="verify-text-link" href="/agent">{c.workspaceAdvanced}<ArrowRight size={14} aria-hidden="true" /></Link></div>
      </section>

      <section className="verify-protection" aria-labelledby="verify-protection-title" id="how-it-works">
        <div className="verify-protection-intro"><ShieldCheck size={28} strokeWidth={1.4} aria-hidden="true" /><div><p className="verify-overline">{c.protectionLabel}</p><h2 id="verify-protection-title">{c.protectionTitle}</h2><p>{c.protectionCopy}</p></div></div>
        <details className="verify-mechanism">
          <summary>{c.protectionMore}<ChevronDown size={17} aria-hidden="true" /></summary>
          <div className="verify-mechanism-content">
            <section className="verify-evidence" aria-labelledby="verify-why-title">
              <div className="verify-section-heading"><div><p className="verify-overline">{c.riskLabel}</p><h2 id="verify-why-title">{c.riskTitle}</h2></div><p>{c.riskIntro}</p></div>
              <div className="verify-checks">{c.risks.map((risk, i) => {
                const Icon = RISK_ICONS[i]!;
                return <article key={risk.name} className="verify-check"><div className="verify-check-top"><span>0{i + 1} / {risk.name}</span><Icon size={23} strokeWidth={1.3} aria-hidden="true" /></div><h3>{risk.title}</h3><p>{risk.detail}</p><span className="verify-check-annotation">{risk.annotation}</span></article>;
              })}</div>
            </section>
            <section className="verify-process" aria-labelledby="verify-process-title">
              <div><p className="verify-overline">{c.processLabel}</p><h2 id="verify-process-title">{c.processTitle}</h2><p className="verify-process-copy">{c.processCopy}</p><div className="verify-policy-options"><p>{c.policiesLabel}</p><ul>{c.policies.map((policy) => <li key={policy}>{policy}</li>)}</ul></div></div>
              <ol className="verify-steps">{c.steps.map((step, i) => <li key={step.title}><span className="verify-step-number">0{i + 1}</span><div><h3>{step.title}</h3><p>{step.copy}</p></div></li>)}</ol>
            </section>
          </div>
        </details>
      </section>

      <section className="verify-tools-directory" aria-labelledby="verify-tools-title">
        <div className="verify-section-heading"><div><p className="verify-overline">{c.toolsLabel}</p><h2 id="verify-tools-title">{c.toolsTitle}</h2></div><p>{c.toolsCopy}</p></div>
        <div className="verify-tool-groups">{c.groups.map((group) => <div className="verify-tool-group" key={group.title}><h3>{group.title}</h3><ul>{group.links.map((link) => <li key={link.href}><Link href={link.href}><span><strong>{link.label}</strong><small>{link.detail}</small></span><ArrowUpRight size={15} aria-hidden="true" /></Link></li>)}</ul></div>)}</div>
      </section>

      <section className="verify-developer" aria-labelledby="verify-developer-title">
        <Braces className="verify-developer-icon" size={35} strokeWidth={1.2} aria-hidden="true" /><div><p className="verify-overline">{c.developerLabel}</p><h2 id="verify-developer-title">{c.developerTitle}</h2><p className="verify-developer-copy">{c.developerCopy}</p></div><Link className="verify-text-link" href="/developers">{c.developerAction}<ArrowUpRight size={17} aria-hidden="true" /></Link>
      </section>
      <p className="verify-home-endnote">{c.endnote}<span aria-hidden="true">✳</span>CHACONNE AGENT</p>
    </div>
  );
}
