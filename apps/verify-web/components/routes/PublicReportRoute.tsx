"use client";
/** 路由开关（见 TaskPage.tsx）：条件是内联的 process.env 字面量，死分支在构建期删掉 */
import { PublicReportClient } from "@/components/PublicReportClient";
import { PublicReportPage } from "@/components/features/public/PublicReportPage";

export function PublicReportRoute({ shareId }: { shareId: string }) {
  return process.env.NEXT_PUBLIC_V8_UI === "1" ? <PublicReportPage shareId={shareId} /> : <PublicReportClient shareId={shareId} />;
}
