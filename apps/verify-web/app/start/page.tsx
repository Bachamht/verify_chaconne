import { Onboarding } from "@/components/onboarding/Onboarding";
import { Suspense } from "react";

export default function StartPage() {
  return <Suspense fallback={<p role="status">Loading…</p>}><Onboarding /></Suspense>;
}
