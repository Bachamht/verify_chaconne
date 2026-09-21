import { Suspense } from "react";
import { BundleVerifier } from "@/components/BundleVerifier";

export default function VerifyBundlePage() {
  return (
    <Suspense fallback={null}>
      <BundleVerifier />
    </Suspense>
  );
}
