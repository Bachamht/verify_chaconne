"use client";
/** 路由开关（见 TaskPage.tsx）：条件是内联的 process.env 字面量，死分支在构建期删掉 */
import { AgentWatchBoard } from "@/components/live/AgentWatchBoard";
import { WatchBoardPage } from "@/components/features/public/WatchBoardPage";

export function WatchBoardRoute({ shareId }: { shareId: string }) {
  return process.env.NEXT_PUBLIC_V8_UI === "1" ? <WatchBoardPage shareId={shareId} /> : <AgentWatchBoard shareId={shareId} />;
}
