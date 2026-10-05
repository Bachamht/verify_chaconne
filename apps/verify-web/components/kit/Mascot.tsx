import Image from "next/image";
import { cn } from "@/lib/utils";

/**
 * 小指挥家（tokens.md §5）：只在首页 hero、/start 第一步、空状态、成功页、404 出现；
 * 工作区页头、表格、数字区、执行页禁止。不做漂浮动画。
 * size：hero ≤ 360 · empty ≤ 120。
 */
export function Mascot({ size = "empty", alt, className, priority = false }: { size?: "hero" | "empty"; alt: string; className?: string; priority?: boolean }) {
  const px = size === "hero" ? 360 : 120;
  return (
    <Image
      src="/brand/conductor-v1.jpg"
      alt={alt}
      width={px}
      height={px}
      priority={priority}
      className={cn("h-auto rounded-lg object-contain", size === "hero" ? "w-full max-w-90" : "w-full max-w-30", className)}
    />
  );
}
