import type { ReactNode } from "react";
import { AgentShell } from "@/components/agent/shared";
import { WalletGate } from "@/components/WalletGate";

/** /agent 页面族：钱包地址就是账户，整个工作区都在连接钱包之后 */
export default function AgentLayout({ children }: { children: ReactNode }) {
  return <AgentShell><WalletGate>{children}</WalletGate></AgentShell>;
}
