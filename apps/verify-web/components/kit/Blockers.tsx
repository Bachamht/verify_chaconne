"use client";
import type { ReactNode } from "react";
import { useI18n } from "@/lib/i18n";
import { hasReasonText, reasonText } from "@/lib/reasons";
import { reasonLevel, reasonNeedsYou, type ReasonLevel } from "@/lib/reasonLevels";
import { cn } from "@/lib/utils";
import { StatusBadge } from "./StatusBadge";
import { Timestamp } from "./Timestamp";

export interface BlockerItem {
  code: string;
  /** 已有的人话（如服务端按 locale 给的）；没有就查 lib/reasons */
  text?: string | null;
  level?: ReasonLevel;
  nextCheckAt?: string | null;
  needsYou?: boolean;
  /** 每条的附加信息（如诊断页的证据时间 / 证据条数），显示在正文下方 */
  meta?: ReactNode;
}

const DOT: Record<ReasonLevel, string> = { wait: "bg-info", warn: "bg-warn", block: "bg-bad" };
const LEVEL_SR: Record<ReasonLevel, { zh: string; en: string }> = {
  wait: { zh: "按设计等待", en: "Waiting by design" },
  warn: { zh: "需要注意", en: "Needs attention" },
  block: { zh: "被拦住", en: "Blocked" },
};

/** 未映射的原因码不露 SNAKE_CASE：给一句通用话，原码放 title 与开发者视图 */
export function blockerText(item: BlockerItem, locale: "zh" | "en"): string {
  if (item.text) return item.text;
  if (hasReasonText(item.code)) return reasonText(item.code, locale);
  return locale === "zh" ? "另有一项条件暂未满足（详情见开发者信息）" : "Another condition is not met yet (see developer details)";
}

/**
 * 阻塞项 / 拒绝理由：等级色点 + 中文短句 +「下次检查 · 时间」+「需要你」徽章。
 * hideNextCheck：暂停态不显示下次检查（方案 §5.6）。
 */
export function Blockers({ items, hideNextCheck = false, empty, className }: {
  items: BlockerItem[];
  hideNextCheck?: boolean;
  empty?: ReactNode;
  className?: string;
}) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  if (items.length === 0) return empty ? <>{empty}</> : null;
  const order: Record<ReasonLevel, number> = { warn: 0, block: 1, wait: 2 };
  const sorted = [...items].sort((a, b) => order[a.level ?? reasonLevel(a.code)] - order[b.level ?? reasonLevel(b.code)]);
  return (
    <ul className={cn("flex flex-col divide-y divide-line", className)}>
      {sorted.map((it, i) => {
        const level = it.level ?? reasonLevel(it.code);
        const needsYou = it.needsYou ?? reasonNeedsYou(it.code);
        return (
          <li key={`${it.code}:${i}`} className="flex min-w-0 items-start gap-3 py-2.5" title={it.code}>
            <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", DOT[level])} aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="text-sm break-words text-fg-1">
                <span className="sr-only">{LEVEL_SR[level][locale]}：</span>
                {blockerText(it, locale)}
              </p>
              {!hideNextCheck && it.nextCheckAt ? (
                <p className="mt-0.5 text-xs text-fg-3">{zh ? "下次检查 · " : "Next check · "}<Timestamp at={it.nextCheckAt} mode="both" /></p>
              ) : null}
              {it.meta ? <div className="mt-1 text-xs text-fg-3">{it.meta}</div> : null}
            </div>
            {needsYou ? <StatusBadge status="needs_you" /> : null}
          </li>
        );
      })}
    </ul>
  );
}
