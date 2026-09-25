import { Suspense } from "react";
import { NewJobForm } from "@/components/NewJobForm";
import { WalletGate } from "@/components/WalletGate";

export default function NewPage() {
  return (
    <Suspense fallback={null}>
      <WalletGate><NewJobForm /></WalletGate>
    </Suspense>
  );
}
