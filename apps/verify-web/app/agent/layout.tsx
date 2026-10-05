import type { ReactNode } from "react";
import { AgentShell } from "@/components/agent/shared";
import { WalletGate } from "@/components/WalletGate";
import { V8_UI } from "@/lib/v8";

/** /agent 页面族：钱包地址就是账户，整个工作区都在连接钱包之后。v8 的侧栏 / 顶栏由根布局的 AppShell 提供 */
export default function AgentLayout({ children }: { children: ReactNode }) {
  if (V8_UI) return <WalletGate>{children}</WalletGate>;
  return <AgentShell><WalletGate>{children}</WalletGate></AgentShell>;
}
