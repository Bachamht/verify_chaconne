"use client";
/** 路由开关（见 TaskPage.tsx）：条件是内联的 process.env 字面量，死分支在构建期删掉 */
import { BundleVerifier } from "@/components/BundleVerifier";
import { BundleVerifierPage } from "@/components/features/public/BundleVerifierPage";

export function BundleRoute() {
  return process.env.NEXT_PUBLIC_V8_UI === "1" ? <BundleVerifierPage  /> : <BundleVerifier  />;
}
