import { Suspense } from "react";
import { TodayRoute } from "@/components/routes/TodayRoute";

export default function AgentPage() {
  return <Suspense fallback={null}><TodayRoute /></Suspense>;
}
