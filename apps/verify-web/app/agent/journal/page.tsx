import { Suspense } from "react";
import { Journal } from "@/components/agent/journal/Journal";

export default function AgentJournalPage() {
  return (
    <Suspense fallback={null}>
      <Journal />
    </Suspense>
  );
}
