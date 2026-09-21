import { Suspense } from "react";
import { PlanClient } from "@/components/PlanClient";

export default function PlanPage() {
  return (
    <Suspense fallback={null}>
      <PlanClient />
    </Suspense>
  );
}
