import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

/**
 * 本项目自定义字号（globals.css @theme：text-md / title / kpi / display）。
 * 不告诉 tailwind-merge 的话，它把 text-kpi 当成文字颜色，和后面的 text-fg-1 合并时会把字号删掉
 * （StatTile 数值、PageHeader 标题都会掉回 14px）。
 */
const twMerge = extendTailwindMerge({
  extend: { theme: { text: ["md", "title", "kpi", "display"] } },
});

/** shadcn 约定：合并 Tailwind 类名（后者覆盖前者） */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
