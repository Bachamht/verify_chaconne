"use client";
/** 路由开关（见 TaskPage.tsx）：条件是内联的 process.env 字面量，死分支在构建期删掉 */
import { ApiKeys } from "@/components/agent/keys/ApiKeys";
import { KeysPage } from "@/components/features/keys/KeysPage";

export function KeysRoute() {
  return process.env.NEXT_PUBLIC_V8_UI === "1" ? <KeysPage /> : <ApiKeys />;
}
