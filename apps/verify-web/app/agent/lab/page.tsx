import { Suspense } from "react";
import { LabClient } from "@/components/agent/lab/LabClient";

export default function AgentLabPage() {
  return (
    <Suspense fallback={null}>
      <LabClient />
    </Suspense>
  );
}
