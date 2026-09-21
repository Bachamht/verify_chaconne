import { Suspense } from "react";
import { PlayClient } from "@/components/PlayClient";

export default function PlayPage() {
  return (
    <Suspense fallback={null}>
      <PlayClient />
    </Suspense>
  );
}
