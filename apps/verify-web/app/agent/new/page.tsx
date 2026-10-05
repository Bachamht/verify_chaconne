import { Suspense, type ComponentType } from "react";
import { redirect } from "next/navigation";

/** /agent/new：v8 唯一的任务创建入口（方案 §5.4）。v8 关闭时没有这一页，回到 /agent 的目标表单；v7 构建不带本页的 v8 代码（死分支） */
/* eslint-disable @typescript-eslint/no-require-imports */
const NewTaskPage: ComponentType | null = process.env.NEXT_PUBLIC_V8_UI === "1" ? require("@/components/features/new-task/NewTaskPage").NewTaskPage : null;
/* eslint-enable @typescript-eslint/no-require-imports */

export default function AgentNewPage() {
  if (!NewTaskPage) redirect("/agent");
  return (
    <Suspense fallback={null}>
      <NewTaskPage />
    </Suspense>
  );
}
