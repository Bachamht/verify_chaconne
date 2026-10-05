import { Suspense } from "react";
import { KeysRoute } from "@/components/routes/KeysRoute";

export default function AgentKeysPage() {
  return <Suspense fallback={null}><KeysRoute /></Suspense>;
}
