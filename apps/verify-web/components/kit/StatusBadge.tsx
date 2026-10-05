"use client";
import { Check, CircleAlert, Clock, FilePen, FlaskConical, Hand, Hourglass, Pause, Undo2, X, Zap, type LucideIcon } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { EVIDENCE_MODE_META, STATUS_META, type EvidenceMode, type StatusIcon, type Tone, type UiStatus } from "@/lib/status";
import { cn } from "@/lib/utils";
import { TONE_DOT, TONE_SOFT } from "./tone";

const ICONS: Record<Exclude<StatusIcon, "dot">, LucideIcon> = {
  clock: Clock, hand: Hand, pause: Pause, check: Check, x: X, alert: CircleAlert,
  flask: FlaskConical, zap: Zap, pen: FilePen, hourglass: Hourglass, undo: Undo2,
};

const BASE = "inline-flex h-5.5 shrink-0 items-center gap-1 rounded-sm border px-2 text-xs font-medium whitespace-nowrap tabular-nums";

/** 状态徽章：图标 + 文字，永不只靠颜色（A9）。一行最多两个。 */
export function StatusBadge({ status, className, title }: { status: UiStatus; className?: string; title?: string }) {
  const { locale } = useI18n();
  const meta = STATUS_META[status];
  const Icon = meta.icon === "dot" ? null : ICONS[meta.icon];
  return (
    <span className={cn(BASE, TONE_SOFT[meta.tone], className)} title={title} data-status={status}>
      {Icon ? <Icon className="size-3" aria-hidden="true" /> : <span className={cn("size-1.5 rounded-full", TONE_DOT[meta.tone])} aria-hidden="true" />}
      {meta[locale]}
    </span>
  );
}

/** 数据来源模式标签（LIVE / 回放 / 示例…）：证据区每条都要可见 */
export function ModeTag({ mode, className }: { mode: EvidenceMode; className?: string }) {
  const { locale } = useI18n();
  const meta = EVIDENCE_MODE_META[mode];
  return <span className={cn(BASE, TONE_SOFT[meta.tone], className)} data-mode={mode} translate="no">{meta[locale]}</span>;
}

/** 通用色调标签（分类 / 等级），状态请用 StatusBadge */
export function ToneTag({ tone, children, className }: { tone: Tone; children: React.ReactNode; className?: string }) {
  return <span className={cn(BASE, TONE_SOFT[tone], className)}>{children}</span>;
}
