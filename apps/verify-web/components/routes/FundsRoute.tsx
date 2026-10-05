"use client";
/** 路由开关（见 TaskPage.tsx）：条件是内联的 process.env 字面量，死分支在构建期删掉 */
import { Funds } from "@/components/agent/funds/Funds";
import { FundsPage } from "@/components/features/funds/FundsPage";

export function FundsRoute() {
  return process.env.NEXT_PUBLIC_V8_UI === "1" ? <FundsPage /> : <Funds />;
}
