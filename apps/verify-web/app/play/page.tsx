import { redirect } from "next/navigation";

/** 批次 7：试玩并入「开始体验」（/start：目标式任务 + 扮演 Agent 走一轮）；旧链接转向。旧的模拟记录仍可在 /agent/tasks 的记录里看到。 */
export default function PlayPage() {
  redirect("/start");
}
