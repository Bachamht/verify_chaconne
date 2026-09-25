import { Suspense } from "react";
import { PlanClient } from "@/components/PlanClient";
import { WalletGate } from "@/components/WalletGate";

export default function PlanPage() {
  return (
    <Suspense fallback={null}>
      <WalletGate><PlanClient /></WalletGate>
    </Suspense>
  );
}
