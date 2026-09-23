import { Suspense } from "react";
import { EventDesk } from "@/components/agent/events/EventDesk";

export const metadata = { title: "My Event Desk — Chaconne Agent" };

export default function AgentEventsPage() {
  return (
    <Suspense fallback={null}>
      <EventDesk />
    </Suspense>
  );
}
