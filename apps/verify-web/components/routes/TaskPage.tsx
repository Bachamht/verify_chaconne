"use client";
/**
 * 路由开关（客户端）：条件必须是 DefinePlugin 内联后的字面量（直接写 process.env…），webpack 解析期就丢掉死分支，
 * v8 构建不再夹带 v7 代码；package.json 的 sideEffects 只保留 CSS。阶段 5 删开关时整个 routes/ 目录一起删。
 */
import { TaskDetail } from "@/components/agent/tasks/TaskDetail";
import { TaskConsole } from "@/components/features/task-console/TaskConsole";

export function TaskPage({ id }: { id: string }) {
  return process.env.NEXT_PUBLIC_V8_UI === "1" ? <TaskConsole id={id} /> : <TaskDetail id={id} />;
}
