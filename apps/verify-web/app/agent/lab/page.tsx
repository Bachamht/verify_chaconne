import { Suspense } from "react";
import { redirect } from "next/navigation";
import { LabRoute } from "@/components/features/lab/LabPage";

/** 批次 7：决策实验页下线——等待诊断已在任务详情，方案比较属于规则试算（MCP compare_task_policies 仍可用）。旧链接转向我的任务。
 *  v8：实验页回归（诊断 / 对照 / 回放三个 tab，方案 §5.8），这三项只在这里实现。 */
export default function AgentLabPage() {
  if (process.env.NEXT_PUBLIC_V8_UI === "1") return <Suspense fallback={null}><LabRoute /></Suspense>;
  redirect("/agent/tasks");
}
