import { Suspense } from "react";
import { FundsRoute } from "@/components/routes/FundsRoute";

export default function AgentFundsPage() {
  return <Suspense fallback={null}><FundsRoute /></Suspense>;
}
