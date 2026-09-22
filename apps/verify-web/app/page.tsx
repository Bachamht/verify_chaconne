"use client";

import Link from "next/link";
import { ArrowDown, ArrowRight, ArrowUpRight, Braces, Fingerprint, ScanLine, Timer } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { Conductor } from "@/components/Conductor";
import "./home.css";

const COPY = {
  zh: {
    before: "先别", after: "让证据开口。",
    lead: "同名代币，过时报价，意外的价格冲击。下单前，让差价君一项项查清楚。",
    start: "先核验一下", agent: "接入你的 Agent", discover: "看看怎么查",
    rule: "你的交易，你定边界。", ruleDetail: "Verify 负责查证。",
    evidenceLabel: "不靠直觉 · 靠这三件事", evidenceTitle: "名字不够。\n把证据对上。",
    evidenceIntro: "把链上美股的身份、价格时点与成交条件放在一起，给你一份有据可查的判断。",
    checks: [
      { title: "它真是你要的资产？", detail: "按链和合约地址核对资产身份。同名代币，也要重新查。", annotation: "链 + 合约地址", name: "IDENTITY" },
      { title: "这价格，是什么时候的？", detail: "区分实时价格与收盘参考，标明源时间。过时的数据不装实时。", annotation: "数据源 + 源时间", name: "FRESHNESS" },
      { title: "这笔单，符合你的边界？", detail: "核对可成交报价、价格冲击和你的限额。证据不足，也会明确说。", annotation: "报价 + 价格冲击 + 限额", name: "EXECUTION" },
    ],
    processLabel: "PROOF BEFORE EXECUTION", processTitle: "先看清楚。\n再决定下一步。",
    processCopy: "核验给出证据与原因；是否继续，始终由你决定。",
    steps: [
      { title: "说清楚，你想怎么交易。", copy: "选择资产、金额与核验策略，设定滑点和价格冲击上限。" },
      { title: "拿到结论，也拿到依据。", copy: "满足策略、信息不足或不通过，都有明确原因和可复查的证据。信息不足时不能执行。" },
      { title: "决定执行时，再查一次。", copy: "可执行交易需重新核验与钱包签名，Guard 按签署的边界执行。" },
    ],
    policiesLabel: "三种策略，由你选择", policies: ["实时价格", "收盘参考", "仅核对报价"],
    developerLabel: "FOR YOUR AGENT", developerTitle: "Agent 也需要\n一点怀疑精神。",
    developerCopy: "把核验接进你的工作流。用 API、SDK 或 MCP，拿到结构化结论、原因码与证据包。",
    developerAction: "查看接入文档", endnote: "有趣的外表。认真的证据。",
  },
  en: {
    before: "Less", after: "More proof.",
    lead: "Same-name tokens. Stale prices. Unexpected price impact. Let your tiny conductor check the evidence before you trade.",
    start: "Verify a trade", agent: "Connect your agent", discover: "See what we check",
    rule: "Your trade. Your boundaries.", ruleDetail: "Verify checks the evidence.",
    evidenceLabel: "THREE CHECKS. FEWER ASSUMPTIONS.", evidenceTitle: "A name is not\nenough evidence.",
    evidenceIntro: "Bring token identity, price timing and execution conditions together for a decision you can inspect.",
    checks: [
      { title: "Is it the asset you mean?", detail: "Match the chain and contract address. A familiar ticker still needs its own evidence.", annotation: "Chain + contract address", name: "IDENTITY" },
      { title: "When was that price?", detail: "Separate a live price from a closing reference. Keep the source time visible.", annotation: "Source + source time", name: "FRESHNESS" },
      { title: "Does this trade fit?", detail: "Check the executable quote, price impact and your limits. Missing evidence stays explicit.", annotation: "Quote + impact + limits", name: "EXECUTION" },
    ],
    processLabel: "PROOF BEFORE EXECUTION", processTitle: "See it clearly.\nThen make your move.",
    processCopy: "Verification gives you evidence and reasons. The decision to continue stays with you.",
    steps: [
      { title: "Set the trade you have in mind.", copy: "Choose an asset, amount and policy. Set your slippage and price impact limits." },
      { title: "Get the answer. And the receipts.", copy: "Eligible, limited or rejected: every conclusion comes with reasons and evidence you can re-check. A limited result cannot be executed." },
      { title: "Check again when you execute.", copy: "An eligible trade needs fresh verification and your wallet signature. Guard enforces the signed boundaries." },
    ],
    policiesLabel: "Three policies. Your choice.", policies: ["Live reference", "Closing reference", "Quote only"],
    developerLabel: "FOR YOUR AGENT", developerTitle: "Give your agent\na skeptical side.",
    developerCopy: "Add verification to your workflow. Get structured verdicts, reason codes and evidence bundles through the API, SDK or MCP.",
    developerAction: "Read the developer docs", endnote: "Meme energy. Serious evidence.",
  },
};

const CHECK_ICONS = [Fingerprint, Timer, ScanLine];

export default function Home() {
  const { locale } = useI18n();
  const c = COPY[locale];
  return (
    <div className="verify-home" data-locale={locale}>
      <section className="verify-hero" aria-labelledby="verify-hero-title">
        <div className="verify-hero-watermark" aria-hidden="true">Verify.</div>
        <svg className="verify-hero-score" viewBox="0 0 1200 360" fill="none" preserveAspectRatio="none" aria-hidden="true">
          {[0, 16, 32, 48, 64].map((offset) => <path key={offset} d={`M-80 ${330 + offset} C 300 ${330 + offset}, 750 ${30 + offset}, 1300 ${70 + offset}`} />)}
        </svg>
        <div className="verify-hero-copy">
          <p className="verify-overline"><span aria-hidden="true" />VERIFY / PROOF BEFORE EXECUTION</p>
          <h1 id="verify-hero-title">{c.before} <span className="verify-serif">FOMO.</span><br /><em>{c.after}</em></h1>
          <p className="verify-hero-lead">{c.lead}</p>
          <div className="verify-hero-actions">
            <Link href="/new" className="btn verify-primary">{c.start}<ArrowUpRight size={19} aria-hidden="true" /></Link>
            <Link href="/developers" className="verify-text-link">{c.agent}<ArrowRight size={16} aria-hidden="true" /></Link>
          </div>
          <div className="verify-hero-signoff"><span>MEME ENERGY.</span><span>SERIOUS EVIDENCE.</span></div>
        </div>
        <div className="verify-hero-character"><Conductor state="idle" variant="hero" locale={locale} /></div>
        <a className="verify-discover" href="#evidence">{c.discover}<ArrowDown size={14} aria-hidden="true" /></a>
      </section>

      <div className="verify-principle"><p>{c.rule} <strong>{c.ruleDetail}</strong></p><span className="mono">STOCKPROOF / RWA GUARD</span></div>

      <section id="evidence" className="verify-evidence" aria-labelledby="verify-evidence-title">
        <div className="verify-section-heading">
          <div><p className="verify-overline">{c.evidenceLabel}</p><h2 id="verify-evidence-title">{c.evidenceTitle}</h2></div>
          <p>{c.evidenceIntro}</p>
        </div>
        <div className="verify-checks">
          {c.checks.map((check, i) => {
            const Icon = CHECK_ICONS[i]!;
            return <article key={check.name} className="verify-check">
              <div className="verify-check-top"><span className="mono">0{i + 1} / {check.name}</span><Icon size={25} strokeWidth={1.3} aria-hidden="true" /></div>
              <h3>{check.title}</h3><p>{check.detail}</p>
              <span className="verify-check-annotation"><span aria-hidden="true" />{check.annotation}</span>
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
      <p className="verify-home-endnote">{c.endnote}<span aria-hidden="true">✳</span>CHACONNE VERIFY</p>
    </div>
  );
}
