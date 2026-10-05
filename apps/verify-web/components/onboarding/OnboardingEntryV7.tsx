"use client";
import Image from "next/image";
import { useAccount } from "@/lib/useAccount";
import { useI18n } from "@/lib/i18n";
import { WalletGate } from "@/components/WalletGate";
import { OnboardingV7 } from "./OnboardingV7";
import "./onboardingV7.css";

export function OnboardingEntryV7() {
  const account = useAccount();
  const { locale } = useI18n();
  const zh = locale === "zh";
  if (account) return <OnboardingV7 key={account.toLowerCase()} account={account} />;
  const steps = zh ? [
    ["01", "交代一个目标", "选标的、定预算，把想法交给内置 Chaconne Agent。"],
    ["02", "先看它如何判断", "观察真实的 Agent 活动记录，这一步不执行链上交易。"],
    ["03", "满意后，再逐项授权", "核对交易边界与额度，授权后由平台执行。"],
  ] : [
    ["01", "Give it a goal", "Choose assets and a budget for the built-in Chaconne Agent."],
    ["02", "Watch its decisions", "Read actual agent activity. This step executes no on-chain trades."],
    ["03", "Then authorize each item", "Review trade boundaries and allowances before platform execution."],
  ];
  return <div className="start7 start7-welcome"><header className="start7-heading"><div><p className="start7-eyebrow">{zh ? "你的第一个交易任务" : "YOUR FIRST AI TRADING MISSION"}</p><h1>{zh ? "不用自带 Agent，也能开始。" : "Your first agent is already here."}</h1><p>{zh ? "先把交易目标说清楚。观察它怎么思考，再决定是否让它真实运行。" : "Describe your trading goal. Watch how it reasons, then decide whether to go live."}</p></div><Image className="start7-mascot" src="/brand/conductor-v1.jpg" alt="" width={112} height={112} unoptimized /></header><div className="start7-welcome-steps">{steps.map(([n, h, p]) => <div key={n}><b>{n}</b><h2>{h}</h2><p>{p}</p></div>)}</div><WalletGate title={zh ? "连接钱包，保存你的任务" : "Connect a wallet to keep your tasks"} description={zh ? "钱包地址是你的账户。连接本身不签名；首次读写记录时需签一条登录消息，不是交易，也不产生交易费用。观察模式所有钱包都能用；托管的真实运行目前只对受邀钱包开放。" : "Your wallet address is your account. Connecting does not sign; first access to records requires a sign-in message, not a transaction, with no transaction fee. Observation is open to every wallet. Hosted live runs are invite-only for now."}>{(who) => <OnboardingV7 key={who.toLowerCase()} account={who} />}</WalletGate></div>;
}
