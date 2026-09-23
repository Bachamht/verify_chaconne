import type { ReactNode } from "react";
import { AgentShell } from "@/components/agent/shared";

/** /agent 页面族（Lane F）：首页 / tasks / funds / journal；/agent/events 归 Lane D、/agent/lab 归 Lane E，只在子导航里链接 */
export default function AgentLayout({ children }: { children: ReactNode }) {
  return <AgentShell>{children}</AgentShell>;
}
