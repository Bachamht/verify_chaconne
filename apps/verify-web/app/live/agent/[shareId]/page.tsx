import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { V7_UI } from "@/lib/v7";
import { WatchBoardRoute } from "@/components/routes/WatchBoardRoute";

/** P6 公开值守看板：只读，只显示类别与时间。NEXT_PUBLIC_V7_UI 关闭时这个路由不存在（404），站点与今天一致。 */
export const metadata: Metadata = { title: "Chaconne Agent · watch board", robots: { index: false } };

export default async function AgentWatchPage({ params }: { params: Promise<{ shareId: string }> }) {
  if (!V7_UI) notFound();
  const { shareId } = await params;
  return <WatchBoardRoute shareId={shareId} />;
}
