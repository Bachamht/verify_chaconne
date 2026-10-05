"use client";
/** 路由开关（见 TaskPage.tsx）：条件是内联的 process.env 字面量，死分支在构建期删掉 */
import { TaskClient } from "@/components/TaskClient";
import { TaskPage } from "@/components/features/tools/TaskPage";

export function MandateRoute({ id }: { id: string }) {
  return process.env.NEXT_PUBLIC_V8_UI === "1" ? <TaskPage id={id} /> : <TaskClient id={id} />;
}
