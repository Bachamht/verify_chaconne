"use client";
/** 路由开关（见 TaskPage.tsx）：条件是内联的 process.env 字面量，死分支在构建期删掉 */
import { Journal } from "@/components/agent/journal/Journal";
import { JournalRoute } from "@/components/features/journal/JournalPage";

export function JournalSwitch() {
  return process.env.NEXT_PUBLIC_V8_UI === "1" ? <JournalRoute /> : <Journal />;
}
