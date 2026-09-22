"use client";

import Link from "next/link";
import { ArrowDown, ArrowRight, ArrowUpRight, Braces, Clock3, Route, Sparkles } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { Conductor } from "@/components/Conductor";
import "./home.css";

/**
 * 首页定位（运营者 2026-09-22）：这里是「让 AI 助手替你交易」的地方，核验是保证它靠谱的手段，不是主角。
 * 叙事顺序固定为：这是什么 → 为什么不能直接让它下单 → 我们怎么保证 → 怎么开始。
 */
const COPY = {
  zh: {
    overline: "代币化美股 · 在 X Layer 执行",
    titleLead: "让 ", titleSerif: "Agent", titleTail: " 交易，", titleEm: "合约守住边界。",
    lead: "把你的 AI 助手接上来，让它在 X Layer 上替你买卖代币化美股。每一笔在下单前先核验一遍，再由链上合约按你签过的边界执行。",
    ctaTry: "我自己试一次", ctaAgent: "接入我的 Agent", ctaPlay: "先看一次模拟（不花钱）",
    discover: "它到底在防什么",
    signoff: ["AGENT 下单。", "合约说了算。"],

    rule: "模型可以被一段文字说服。", ruleDetail: "合约不能。",

    riskLabel: "为什么不直接让它下单", riskTitle: "它不是会算错。\n是它没法自己验证。",
    riskIntro: "让模型把股票代码和金额说对，早就不是难题。真正危险的三件事，都发生在它的推理之外。",
    risks: [
      { name: "STALE", title: "它拿到的价，可能是旧的。", detail: "多数行情接口只给一个数字，不告诉你这个数字是什么时候成立的。四十分钟前的价和三秒前的价，在模型眼里长得一模一样。", annotation: "源时间 ≠ 接收时间" },
      { name: "IMPOSTOR", title: "链上任何人都能发一枚同名代币。", detail: "代币的名称与符号，是部署者随手写的字符串。模型读一份代币列表，看到的就是这些字符串。", annotation: "名字不是身份" },
      { name: "DRIFT", title: "它想好的那笔，出块前可能已经变样。", detail: "从决定到成交隔着几十秒。价格在动、报价在过期、路由可能已经不是它看过的那条。", annotation: "决定 ≠ 成交" },
    ],

    processLabel: "我们怎么保证", processTitle: "三道关卡。\n一道比一道硬。",
    processCopy: "Agent 负责判断，边界交给它碰不到的东西守着。",
    steps: [
      { title: "核验：四类证据，每条带源时间与哈希。", copy: "链上可成交报价与路由、代币的链上身份、OKX RWA 名录登记、股票参考价。判定只有三种——可执行、有限制、拒绝，每种都附原因码。休市时拒绝就是正确答案。" },
      { title: "证书：约 30 秒时效，过期即无效。", copy: "只有判定通过才签发，而且不会比它依据的那份报价活得更久。过期后必须重新核验，不能凭一个旧结论上链。" },
      { title: "执行：Guard 合约强制五项。", copy: "花出金额、最少到账、收款人、路由、期限。任何一项对不上就整笔回滚；未用完的输入原路退回，合约上不留余额。" },
    ],
    policiesLabel: "三种核验策略，由你选择", policies: ["实时价格", "收盘参考", "仅核对报价"],

    developerLabel: "FOR YOUR AGENT", developerTitle: "已经有 Agent？\n四行配置接上。",
    developerCopy: "MCP 服务器、TypeScript SDK 或 HTTP 接口，三条路同一个后端。拿到结构化判定、原因码，以及可以离线复验的证据包。",
    developerAction: "查看接入文档",
    endnote: "有趣的外表。认真的证据。",
  },
  en: {
    overline: "Tokenized US stocks · executed on X Layer",
    titleLead: "", titleSerif: "Agents", titleTail: " trade.", titleEm: "Contracts hold the line.",
    lead: "Connect your AI assistant and let it buy and sell tokenized US stocks on X Layer for you. Every order is verified against fresh evidence first, then executed by an on-chain contract inside the boundaries you signed.",
    ctaTry: "Try it myself", ctaAgent: "Connect my agent", ctaPlay: "Watch a simulation (free)",
    discover: "What it actually guards against",
    signoff: ["THE AGENT ORDERS.", "THE CONTRACT DECIDES."],

    rule: "A model can be talked into anything.", ruleDetail: "A contract cannot.",

    riskLabel: "WHY NOT JUST LET IT ORDER", riskTitle: "It rarely gets\nthe math wrong.",
    riskIntro: "Naming the right ticker stopped being hard a long time ago. The three things that actually hurt all happen outside the model's reasoning.",
    risks: [
      { name: "STALE", title: "The price it read may be old.", detail: "Most market feeds hand over a number without saying when that number was true. A forty-minute-old quote and a three-second-old quote look identical to a model.", annotation: "Source time ≠ received time" },
      { name: "IMPOSTOR", title: "Anyone can mint a token with the same name.", detail: "A token's name and symbol are strings its deployer typed. Reading a token list, that is all a model gets to see.", annotation: "A name is not an identity" },
      { name: "DRIFT", title: "The trade it planned can change before it lands.", detail: "Tens of seconds pass between decision and settlement. Prices move, quotes expire, and the route may no longer be the one it looked at.", annotation: "Decided ≠ settled" },
    ],

    processLabel: "HOW WE HOLD THE LINE", processTitle: "Three gates.\nEach one harder.",
    processCopy: "The agent decides. The boundaries are held by something it cannot talk to.",
    steps: [
      { title: "Verify: four kinds of evidence, each with its source time and hash.", copy: "The executable on-chain quote and route, the token's on-chain identity, its entry in the OKX RWA registry, and the stock reference price. Three verdicts only — eligible, limited, rejected — each with reason codes. Outside market hours, rejected is the correct answer." },
      { title: "Certificate: about 30 seconds, then it is void.", copy: "Issued only on a passing verdict, and never outliving the quote it rests on. Once it expires the trade must be re-verified; a stale conclusion never reaches the chain." },
      { title: "Execute: the Guard contract enforces five things.", copy: "Amount in, minimum out, recipient, route and deadline. Miss any one of them and the whole transaction reverts. Unspent input goes straight back; the contract keeps no balance." },
    ],
    policiesLabel: "Three verification policies. Your choice.", policies: ["Live reference", "Closing reference", "Quote only"],

    developerLabel: "FOR YOUR AGENT", developerTitle: "Already have an agent?\nFour lines of config.",
    developerCopy: "An MCP server, a TypeScript SDK or plain HTTP — three paths into the same backend. You get structured verdicts, reason codes and an evidence bundle anyone can re-check offline.",
    developerAction: "Read the developer docs",
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
        <div className="verify-hero-watermark" aria-hidden="true">Agent.</div>
        <svg className="verify-hero-score" viewBox="0 0 1200 360" fill="none" preserveAspectRatio="none" aria-hidden="true">
          {[0, 16, 32, 48, 64].map((offset) => <path key={offset} d={`M-80 ${330 + offset} C 300 ${330 + offset}, 750 ${30 + offset}, 1300 ${70 + offset}`} />)}
        </svg>
        <div className="verify-hero-copy">
          <p className="verify-overline"><span aria-hidden="true" />{c.overline}</p>
          <h1 id="verify-hero-title">{c.titleLead}<span className="verify-serif">{c.titleSerif}</span>{c.titleTail}<br /><em>{c.titleEm}</em></h1>
          <p className="verify-hero-lead">{c.lead}</p>
          <div className="verify-hero-actions">
            <Link href="/new" className="btn verify-primary">{c.ctaTry}<ArrowUpRight size={19} aria-hidden="true" /></Link>
            <Link href="/developers" className="verify-text-link">{c.ctaAgent}<ArrowRight size={16} aria-hidden="true" /></Link>
            <Link href="/play" className="verify-text-link verify-text-link--quiet">{c.ctaPlay}<ArrowRight size={16} aria-hidden="true" /></Link>
          </div>
          <div className="verify-hero-signoff"><span>{c.signoff[0]}</span><span>{c.signoff[1]}</span></div>
        </div>
        <div className="verify-hero-character"><Conductor state="idle" variant="hero" locale={locale} /></div>
        <a className="verify-discover" href="#why">{c.discover}<ArrowDown size={14} aria-hidden="true" /></a>
      </section>

      <div className="verify-principle"><p>{c.rule} <strong>{c.ruleDetail}</strong></p><span className="mono">STOCKPROOF / RWA GUARD</span></div>

      <section id="why" className="verify-evidence" aria-labelledby="verify-why-title">
        <div className="verify-section-heading">
          <div><p className="verify-overline">{c.riskLabel}</p><h2 id="verify-why-title">{c.riskTitle}</h2></div>
          <p>{c.riskIntro}</p>
        </div>
        <div className="verify-checks">
          {c.risks.map((risk, i) => {
            const Icon = RISK_ICONS[i]!;
            return <article key={risk.name} className="verify-check">
              <div className="verify-check-top"><span className="mono">0{i + 1} / {risk.name}</span><Icon size={25} strokeWidth={1.3} aria-hidden="true" /></div>
              <h3>{risk.title}</h3><p>{risk.detail}</p>
              <span className="verify-check-annotation"><span aria-hidden="true" />{risk.annotation}</span>
            </article>;
          })}
        </div>
      </section>

      <section className="verify-process" aria-labelledby="verify-process-title">
        <div className="verify-process-intro"><p className="verify-overline">{c.processLabel}</p><h2 id="verify-process-title">{c.processTitle}</h2><p className="verify-process-copy">{c.processCopy}</p>
          <div className="verify-policy-options"><p>{c.policiesLabel}</p><ul>{c.policies.map((policy) => <li key={policy}>{policy}</li>)}</ul></div>
        </div>
        <ol className="verify-steps">{c.steps.map((step, i) => <li key={step.title}><span className="verify-step-number mono">0{i + 1}</span><div><h3>{step.title}</h3><p>{step.copy}</p></div></li>)}</ol>
      </section>

      <section className="verify-developer" aria-labelledby="verify-developer-title">
        <div className="verify-developer-art" aria-hidden="true"><div className="verify-developer-mark"><Braces size={142} strokeWidth={.65} /></div></div>
        <div><p className="verify-overline">{c.developerLabel}</p><h2 id="verify-developer-title">{c.developerTitle}</h2></div>
        <div className="verify-developer-copy"><p>{c.developerCopy}</p><Link href="/developers">{c.developerAction}<ArrowUpRight size={19} aria-hidden="true" /></Link></div>
      </section>
      <p className="verify-home-endnote">{c.endnote}<span aria-hidden="true">✳</span>CHACONNE AGENT</p>
    </div>
  );
}
