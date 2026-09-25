import { redirect } from "next/navigation";

/** 批次 7：决策实验页下线——等待诊断已在任务详情，方案比较属于规则试算（MCP compare_task_policies 仍可用）。旧链接转向我的任务。 */
export default function AgentLabPage() {
  redirect("/agent/tasks");
}
