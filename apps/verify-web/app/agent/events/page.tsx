import { Suspense } from "react";
import dynamic from "next/dynamic";
import { EventsDesk } from "@/components/features/events/EventsDesk";
import { EventsDeskFallback } from "@/components/features/events/EventsDeskFallback";

// 旧事件台按需加载：v8 构建里不进首屏包
const EventDesk = dynamic(() => import("@/components/agent/events/EventDesk").then((m) => m.EventDesk));

export const metadata = { title: "My Event Desk — Chaconne Agent" };

export default function AgentEventsPage() {
  if (process.env.NEXT_PUBLIC_V8_UI === "1") {
    // 首屏骨架由 Suspense 兜底立刻出（等形，≤ 300 ms），不等钱包 / 会话 / 接口
    return (
      <Suspense fallback={<EventsDeskFallback />}>
        <EventsDesk />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={null}>
      <EventDesk />
    </Suspense>
  );
}
