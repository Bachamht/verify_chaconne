"use client";
/**
 * /start 未连接钱包时：先交代产品和步骤，再请连接。连接本身不签名；登录消息不是交易；真实授权在后面逐项进行。
 * 吉祥物只在这里（第一步）出现。
 */
import { useState } from "react";
import { ArrowUpRight, Eye, ShieldCheck, Wallet } from "lucide-react";
import { AsyncButton } from "@/components/kit/AsyncButton";
import { Mascot } from "@/components/kit/Mascot";
import { useI18n } from "@/lib/i18n";
import { walletErrorText } from "@/lib/i18n.execute";
import { useWalletStatus } from "@/lib/useWalletStatus";
import { connect } from "@/lib/wallet";

export function StartWelcome() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const status = useWalletStatus();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const steps = zh
    ? [["交代一个目标", "选股票、定预算，把想法交给内置的 Chaconne Agent。"], ["先看它如何判断", "观察真实的 Agent 活动记录，这一步不执行链上交易。"], ["满意后，再逐项授权", "核对交易边界与额度，授权后由平台执行。"]]
    : [["Give it a goal", "Choose stocks and a budget for the built-in Chaconne Agent."], ["Watch its decisions", "Read actual agent activity. This step executes no on-chain trades."], ["Then authorize each item", "Review trade boundaries and allowances before platform execution."]];
  const pending = busy || (status.status !== "idle" && status.phase === "connect");
  async function go() {
    setBusy(true);
    setErr(null);
    try { await connect(); } catch (e) { setErr(walletErrorText(e, locale)); } finally { setBusy(false); }
  }
  return (
    <div className="ch-start-welcome">
      <section className="ch-start-intro" aria-labelledby="start-title">
        <p className="ch-eyebrow">{zh ? "你的第一项委托" : "YOUR FIRST MANDATE"}</p>
        <h1 id="start-title">{zh ? <>你的想法，<br /><span>它来跟进。</span></> : <>Your idea.<br /><span>Its next move.</span></>}</h1>
        <p className="ch-start-lead">{zh ? "不用自带 Agent。先说清交易目标，观察它如何研究、判断与等待，再决定是否交给它执行。" : "Your agent is already here. Give it a goal, watch it research and make decisions, then choose whether to let it trade."}</p>
        <ol className="ch-start-steps" aria-label={zh ? "三步" : "Three steps"}>
          {steps.map(([title, desc], i) => <li key={title}><span className="ch-start-step-number" aria-hidden="true">0{i + 1}</span><div><h2>{title}</h2><p>{desc}</p></div></li>)}
        </ol>
      </section>
      <section className="ch-start-connect" aria-labelledby="start-connect-title">
        <div className="ch-start-mascot"><Mascot priority alt={zh ? "Chaconne 小指挥家" : "Chaconne conductor"} className="w-30" /></div>
        <span className="ch-start-caption">{zh ? "准备好，听你的安排。" : "Ready when you are."}</span>
        <h2 id="start-connect-title">{zh ? "给 Agent 一个开始" : "Give your agent a start"}</h2>
        <p className="text-sm leading-relaxed text-fg-2">{zh ? "连接钱包，保存你的任务。钱包地址就是你的账户。" : "Connect your wallet to keep your tasks. Your wallet address is your account."}</p>
        <AsyncButton size="lg" className="ch-start-connect-button" pending={pending} pendingLabel={status.walletName ? (zh ? `正在连接 ${status.walletName}` : `Connecting ${status.walletName}`) : (zh ? "正在连接钱包" : "Connecting wallet")} onClick={() => void go()}>
          <Wallet aria-hidden="true" />{zh ? "连接钱包" : "Connect wallet"}<ArrowUpRight aria-hidden="true" className="ml-auto" />
        </AsyncButton>
        {err ? <p className="text-sm text-bad" role="alert">{err}</p> : null}
        <div className="ch-start-assurances">
          <p><Eye aria-hidden="true" /><span>{zh ? "先观察 Agent，不执行交易。" : "Observe first. No trades are executed."}</span></p>
          <p><ShieldCheck aria-hidden="true" /><span>{zh ? "真实运行前，逐项确认授权。" : "Review each authorization before going live."}</span></p>
        </div>
        <p className="ch-start-disclosure">{zh ? "连接本身不签名；首次读写记录需签一条登录消息，它不是交易，也不产生交易费用。观察模式所有钱包都能用，托管的真实运行目前只对受邀钱包开放。" : "Connecting does not sign. First access to records requires a sign-in message, not a transaction, with no fee. Observation is open to every wallet. Hosted live runs are invite-only for now."}</p>
      </section>
    </div>
  );
}
