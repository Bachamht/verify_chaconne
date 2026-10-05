import { Suspense, type ComponentType } from "react";

/**
 * v7 / v8 两套各自拆包：条件直接写 process.env（构建期内联成字面量），webpack 删掉死分支的 require，
 * 当前开关之外的那一套不进本页的包（import 写法两套都会进包，v7 构建会多出 v8 的表单依赖）。
 */
/* eslint-disable @typescript-eslint/no-require-imports */
const Page: ComponentType = process.env.NEXT_PUBLIC_V8_UI === "1"
  ? require("@/components/features/onboarding/StartV8").StartV8
  : require("@/components/onboarding/Onboarding").Onboarding;
/* eslint-enable @typescript-eslint/no-require-imports */

export default function StartPage() {
  return <Suspense fallback={process.env.NEXT_PUBLIC_V8_UI === "1" ? null : <p role="status">Loading…</p>}><Page /></Suspense>;
}
