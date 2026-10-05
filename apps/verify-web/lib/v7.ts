/**
 * v7 界面总开关（开发计划 §2.12）：构建期变量 NEXT_PUBLIC_V7_UI，缺省 "0"。
 * 关着时站点行为与 v6 完全一致——所有 v7 组件只在 V7_UI 为 true 时挂载。
 * 用点号访问，Next 才会在构建时把它内联成字面量（改动需重建网页）。
 */
/** v8 建在 v7 语义之上：NEXT_PUBLIC_V8_UI=1 时也打开（lib/v8.ts） */
export const V7_UI: boolean = process.env.NEXT_PUBLIC_V7_UI === "1" || process.env.NEXT_PUBLIC_V8_UI === "1";

/**
 * 本地渲染用的 fixture（只在 v7 开着、且地址栏带 ?v7fixture=1 时启用）。
 * fixture 数据一律带 FIXTURE 角标，绝不冒充真实运行。
 */
export function v7FixtureRequested(search: string | null | undefined): boolean {
  if (!V7_UI || !search) return false;
  return new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("v7fixture") === "1";
}
