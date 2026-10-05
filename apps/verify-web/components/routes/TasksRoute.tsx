"use client";
/** 路由开关（见 TaskPage.tsx） */
import { TasksList } from "@/components/agent/tasks/TasksList";
import { TasksPage } from "@/components/features/tasks/TasksPage";

export function TasksRoute() {
  return process.env.NEXT_PUBLIC_V8_UI === "1" ? <TasksPage /> : <TasksList />;
}
