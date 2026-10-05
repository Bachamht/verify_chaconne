"use client";
/** 路由开关（见 TaskPage.tsx）：条件是内联的 process.env 字面量，死分支在构建期删掉 */
import { AgentHome } from "@/components/agent/home/AgentHome";
import { TodayPage } from "@/components/features/today/TodayPage";

export function TodayRoute() {
  return process.env.NEXT_PUBLIC_V8_UI === "1" ? <TodayPage /> : <AgentHome />;
}
