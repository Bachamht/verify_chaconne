import { Suspense } from "react";
import { AgentHome } from "@/components/agent/home/AgentHome";

export default function AgentPage() {
  return (
    <Suspense fallback={null}>
      <AgentHome />
    </Suspense>
  );
}
