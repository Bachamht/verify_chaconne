"use client";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * 没拿到的值：显式写「未返回」，不补 0、不用「—」冒充（V-31）。
 * title 写原因（如「链上读取失败，不当作 0」）；label 可换成更具体的说法（如「任务未返回」）。
 */
export function NotReturned({ title, label, className }: { title?: string; label?: string; className?: string }) {
  const { locale } = useI18n();
  return <span className={cn("text-fg-3", className)} title={title}>{label ?? (locale === "zh" ? "未返回" : "Not returned")}</span>;
}
