import type { Tone } from "@/lib/status";

/** 状态色：面 12% · 描边 35% · 文字 100%（tokens.md §1）。紫色不表达状态，brand 只给「选中 / 品牌」 */
export const TONE_SOFT: Record<Tone, string> = {
  ok: "bg-ok/12 border-ok/35 text-ok",
  info: "bg-info/12 border-info/35 text-info",
  warn: "bg-warn/12 border-warn/35 text-warn",
  bad: "bg-bad/12 border-bad/35 text-bad",
  neutral: "bg-surface-2 border-line-strong text-fg-2",
  muted: "bg-transparent border-line text-fg-3",
  brand: "bg-surface-brand border-line-brand text-brand-300",
};

export const TONE_TEXT: Record<Tone, string> = {
  ok: "text-ok",
  info: "text-info",
  warn: "text-warn",
  bad: "text-bad",
  neutral: "text-fg-2",
  muted: "text-fg-3",
  brand: "text-brand-300",
};

export const TONE_DOT: Record<Tone, string> = {
  ok: "bg-ok",
  info: "bg-info",
  warn: "bg-warn",
  bad: "bg-bad",
  neutral: "bg-fg-2",
  muted: "bg-fg-3",
  brand: "bg-brand-400",
};
