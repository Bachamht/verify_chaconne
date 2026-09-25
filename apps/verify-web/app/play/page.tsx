import { Suspense } from "react";
import { PlayClient } from "@/components/PlayClient";
import { WalletGate } from "@/components/WalletGate";

export default function PlayPage() {
  return (
    <Suspense fallback={null}>
      <WalletGate><PlayClient /></WalletGate>
    </Suspense>
  );
}
