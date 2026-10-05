"use client";
/** 日志里的 Agent 原话：用 kit 的 AgentQuote（长段落收起 4 行） */
import { AgentQuote as KitAgentQuote } from "@/components/kit/AgentQuote";

export function AgentQuote({ text, kind }: { text: string; kind: "said" | "nextIf" }) {
  return <KitAgentQuote text={text} kind={kind} lines={4} className="mt-1" />;
}
