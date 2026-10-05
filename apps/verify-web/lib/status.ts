/**
 * v8 状态单一来源（components.md「StatusBadge」）：界面状态 → 文案 / 色调 / 图标名。
 * 后端任务状态（TASK_STATUSES）先经 taskUiStatus() 映射成界面状态，页面不直接渲染原始枚举。
 * 图标在 components/kit/StatusBadge.tsx 里按名字取，这里不引 React，便于单测。
 */
import type { Locale } from "./i18n";

export type Tone = "ok" | "info" | "warn" | "bad" | "neutral" | "muted" | "brand";

export const UI_STATUSES = [
  "running", "waiting", "needs_you", "paused", "done", "cancelled", "failed",
  "simulation", "live", "draft", "expired", "revoking", "revoked",
] as const;
export type UiStatus = (typeof UI_STATUSES)[number];

export type StatusIcon = "dot" | "clock" | "hand" | "pause" | "check" | "x" | "alert" | "flask" | "zap" | "pen" | "hourglass" | "undo";

export const STATUS_META: Record<UiStatus, { zh: string; en: string; tone: Tone; icon: StatusIcon }> = {
  running: { zh: "运行中", en: "Running", tone: "ok", icon: "dot" },
  waiting: { zh: "等待", en: "Waiting", tone: "info", icon: "clock" },
  needs_you: { zh: "需要你", en: "Needs you", tone: "warn", icon: "hand" },
  paused: { zh: "已暂停", en: "Paused", tone: "neutral", icon: "pause" },
  done: { zh: "已完成", en: "Done", tone: "ok", icon: "check" },
  cancelled: { zh: "已取消", en: "Cancelled", tone: "muted", icon: "x" },
  failed: { zh: "失败", en: "Failed", tone: "bad", icon: "alert" },
  simulation: { zh: "观察（模拟）", en: "Simulation", tone: "info", icon: "flask" },
  live: { zh: "真实", en: "Live", tone: "ok", icon: "zap" },
  draft: { zh: "草稿", en: "Draft", tone: "muted", icon: "pen" },
  expired: { zh: "已到期", en: "Expired", tone: "muted", icon: "hourglass" },
  revoking: { zh: "撤销中", en: "Revoking", tone: "warn", icon: "undo" },
  revoked: { zh: "已撤销", en: "Revoked", tone: "muted", icon: "undo" },
};

/** 后端任务状态 → 界面状态。未知值按「等待」处理并保留原值给开发者视图，不在页面上露出 SNAKE_CASE */
const TASK_MAP: Record<string, UiStatus> = {
  DRAFT: "draft",
  AWAITING_AUTHORIZATION: "needs_you",
  ACTIVE: "running",
  WAITING: "waiting",
  STEP_PREPARED: "running",
  PARTIAL: "running",
  COMPLETED: "done",
  PAUSED: "paused",
  REVOKE_PENDING: "revoking",
  REVOKED: "revoked",
  EXPIRED: "expired",
  CANCELLED: "cancelled",
};

export function taskUiStatus(status: string | null | undefined): UiStatus {
  return (status && TASK_MAP[status]) || "waiting";
}

export function isKnownTaskStatus(status: string): boolean {
  return status in TASK_MAP;
}

export function modeUiStatus(mode: string | null | undefined): UiStatus | null {
  if (mode === "LIVE") return "live";
  if (mode === "SIMULATION") return "simulation";
  return null;
}

export function statusLabelV8(status: UiStatus, locale: Locale): string {
  return STATUS_META[status][locale];
}

/** 终态：不再显示「下次检查」，控制按钮收起 */
export function isTerminal(status: UiStatus): boolean {
  return status === "done" || status === "cancelled" || status === "expired" || status === "revoked" || status === "failed";
}

/** 证据 / 数据来源模式标签（R-03：sample / backfill 永远不渲染成实时） */
export const EVIDENCE_MODES = ["LIVE", "SIMULATION", "REPLAY", "FIXTURE", "sample", "backfill"] as const;
export type EvidenceMode = (typeof EVIDENCE_MODES)[number];
export const EVIDENCE_MODE_META: Record<EvidenceMode, { zh: string; en: string; tone: Tone }> = {
  LIVE: { zh: "实时", en: "Live", tone: "ok" },
  SIMULATION: { zh: "模拟", en: "Simulation", tone: "info" },
  REPLAY: { zh: "回放", en: "Replay", tone: "info" },
  FIXTURE: { zh: "示例数据", en: "Fixture", tone: "warn" },
  sample: { zh: "样本", en: "Sample", tone: "warn" },
  backfill: { zh: "补录", en: "Backfill", tone: "info" },
};
export function evidenceMode(mode: string | null | undefined): EvidenceMode | null {
  if (!mode) return null;
  if (mode === "live") return "LIVE";
  return (EVIDENCE_MODES as readonly string[]).includes(mode) ? (mode as EvidenceMode) : null;
}
