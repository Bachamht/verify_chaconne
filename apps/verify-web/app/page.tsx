import type { ComponentType } from "react";

/**
 * 首页。v8：components/features/home（不带 home.css / Conductor.css，不带钱包代码）。
 * v8 关闭：旧首页 app/HomeLegacy.tsx（自带 home.css）。
 * 这里不用 `if (V8_UI)` + 两个静态 import：那样两边的代码和 CSS 都会进首页包（next/dynamic 在服务端组件里也不拆）。
 * 改用内联的构建期常量 + require，webpack 在构建时就删掉另一支，首页包只含当前版本。
 */
const Home: ComponentType = process.env.NEXT_PUBLIC_V8_UI === "1"
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- 构建期删死分支，见上
  ? (require("@/components/features/home/HomeV8") as typeof import("@/components/features/home/HomeV8")).HomeV8
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- 构建期删死分支，见上
  : (require("./HomeLegacy") as typeof import("./HomeLegacy")).default;

export default function Page() {
  return <Home />;
}
