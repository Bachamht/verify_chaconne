import { Suspense } from "react";
import { Funds } from "@/components/agent/funds/Funds";

export default function AgentFundsPage() {
  return (
    <Suspense fallback={null}>
      <Funds />
    </Suspense>
  );
}
