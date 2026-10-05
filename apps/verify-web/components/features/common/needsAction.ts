/**
 * 「需要你」待办（runtime.needsOwner）的动作去处：任务控制台与「今天」共用一份映射。
 * 离开任务的三种：新建任务 → /agent/new；收回额度 / 补资金 → 资金页的额度区（#allowances）。
 * 其余都在任务页里处理：控制台里直接打开；其它页面链到任务页并带 ?do=…，到了直接打开对应面板或确认框。
 */
import type { NeedsOwnerItem } from "@chaconne/core/verify";
import type { Locale } from "@/lib/i18n";
import { deepActionHref } from "@/lib/useDeepAction";

export type NeedKind = NeedsOwnerItem["action"]["kind"] | "open";
export interface NeedAction { href: string; label: string }

export const FUNDS_ALLOWANCES_HREF = "/agent/funds#allowances";

/** 需要离开任务页去处理的动作 → 去处；在任务页里处理的返回 null */
export function needExternalHref(kind: NeedKind): string | null {
  switch (kind) {
    case "create_new_task": return "/agent/new";
    case "reclaim_allowance":
    case "top_up": return FUNDS_ALLOWANCES_HREF;
    default: return null;
  }
}

const LABEL: Record<string, { zh: string; en: string }> = {
  sign_delegation: { zh: "去签授权", en: "Sign the authorization" },
  sign_permit: { zh: "去签额度许可", en: "Sign the allowance permit" },
  confirm_revoke: { zh: "查看撤销进度", en: "Check the revocation" },
  reclaim_allowance: { zh: "去收回额度", en: "Reclaim the allowance" },
  create_new_task: { zh: "新建任务", en: "Create a new task" },
  resume_or_cancel: { zh: "决定继续或取消", en: "Resume or cancel" },
  top_up: { zh: "查看资金", en: "Check funds" },
};

/** 任务页之外（如「今天」）的待办动作：去处 + 按钮文案 */
export function needAction(kind: NeedKind, taskId: string, locale: Locale): NeedAction {
  const page = `/agent/tasks/${taskId}`;
  // 直接到能做这件事的地方：任务页带 ?do=…，打开对应面板 / 确认框（lib/useDeepAction）
  const op = kind === "sign_delegation" || kind === "sign_permit" ? "delegate" : kind === "resume_or_cancel" ? "decide" : kind === "confirm_revoke" ? "revoke" : null;
  const href = needExternalHref(kind) ?? (op ? deepActionHref(page, op) : page);
  const l = LABEL[kind];
  return { href, label: l ? l[locale] : locale === "zh" ? "打开任务" : "Open the task" };
}
