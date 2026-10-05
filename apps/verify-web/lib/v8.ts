/**
 * v8 界面总开关：构建期变量 NEXT_PUBLIC_V8_UI，缺省 "0"（方案 §4.3）。
 * 开着时 <html data-ui="v8">，页面走新壳（AppShell / MarketingShell）与 components/kit；
 * v8 建在 v7 的产品语义之上，所以 V8 开着时 V7_UI 也视为开着（lib/v7.ts）。
 * 用点号访问，Next 才会在构建时把它内联成字面量（改动需重建网页）。
 */
export const V8_UI: boolean = process.env.NEXT_PUBLIC_V8_UI === "1";
