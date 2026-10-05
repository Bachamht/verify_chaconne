import { Suspense } from "react";
import { BundleRoute } from "@/components/routes/BundleRoute";

export default function VerifyBundlePage() {
  return <Suspense fallback={null}><BundleRoute /></Suspense>;
}
