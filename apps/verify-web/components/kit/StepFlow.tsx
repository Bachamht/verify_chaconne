"use client";
import type { ReactNode } from "react";
import { Check, Minus, X } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

export type StepState = "idle" | "active" | "done" | "failed" | "skipped";

/**
 * 显式状态机（任务步骤、执行四步、/start 步骤条、证据包检查）。
 * 竖排：左侧轨道线，当前步品牌色；横排：步骤条。每步 idle / active / done / failed / skipped。
 * <StepFlow><StepFlow.Step state="done" title=… meta=…>内容</StepFlow.Step></StepFlow>
 */
function StepFlowRoot({ children, orientation = "vertical", className, "aria-label": ariaLabel }: {
  children: ReactNode;
  orientation?: "vertical" | "horizontal";
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <ol aria-label={ariaLabel} data-orientation={orientation} className={cn(
      "ch-step-flow group/steps min-w-0",
      orientation === "horizontal" ? "flex w-full items-start gap-3 sm:gap-5" : "flex flex-col",
      className,
    )}>
      {children}
    </ol>
  );
}

const MARK: Record<StepState, string> = {
  idle: "border-line-strong bg-surface-1 text-fg-3",
  active: "border-brand-400 bg-surface-brand text-brand-200",
  done: "border-ok/35 bg-ok/12 text-ok",
  failed: "border-bad/35 bg-bad/12 text-bad",
  skipped: "border-line bg-surface-1 text-fg-3",
};

function StepMark({ state, index }: { state: StepState; index?: number }) {
  return (
    <span className={cn("relative z-1 flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-medium tabular-nums", MARK[state])} aria-hidden="true">
      {state === "done" ? <Check className="size-3.5" /> : state === "failed" ? <X className="size-3.5" /> : state === "skipped" ? <Minus className="size-3.5" /> : index ?? null}
    </span>
  );
}

const STATE_SR: Record<StepState, { zh: string; en: string }> = {
  idle: { zh: "未开始", en: "Not started" },
  active: { zh: "进行中", en: "In progress" },
  done: { zh: "已完成", en: "Done" },
  failed: { zh: "失败", en: "Failed" },
  skipped: { zh: "已跳过", en: "Skipped" },
};

function Step({ state, title, description, meta, index, children, locale: localeProp, last = false }: {
  state: StepState;
  title: ReactNode;
  description?: ReactNode;
  /** 右侧：时间 / 倒计时 */
  meta?: ReactNode;
  /** 圈里的序号（idle / active 时显示） */
  index?: number;
  children?: ReactNode;
  locale?: "zh" | "en";
  /** 竖排最后一步不画轨道线 */
  last?: boolean;
}) {
  const { locale: ctx } = useI18n();
  const locale = localeProp ?? ctx;
  return (
    <li aria-current={state === "active" ? "step" : undefined} className={cn(
      "relative flex min-w-0 gap-3",
      "group-data-[orientation=vertical]/steps:pb-6 group-data-[orientation=vertical]/steps:last:pb-0",
      "group-data-[orientation=horizontal]/steps:flex-1 group-data-[orientation=horizontal]/steps:items-start",
    )}>
      {!last && (
        <span aria-hidden="true" className={cn(
          "absolute bg-line group-data-[orientation=horizontal]/steps:hidden",
          "top-7 bottom-0 left-3.5 w-px",
          state === "done" && "bg-ok/35",
        )} />
      )}
      <StepMark state={state} index={index} />
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="flex min-w-0 flex-col gap-1.5 sm:flex-row sm:flex-wrap sm:items-baseline sm:justify-between sm:gap-x-4">
          <p className={cn("min-w-0 text-sm leading-6 font-medium break-words sm:flex-1", state === "idle" || state === "skipped" ? "text-fg-2" : state === "failed" ? "text-bad" : "text-fg-1")}>
            {title}
            <span className="sr-only"> · {STATE_SR[state][locale]}</span>
          </p>
          {meta ? <span className="min-w-0 text-xs leading-5 break-words text-fg-3 sm:ml-auto sm:max-w-1/2 sm:text-right">{meta}</span> : null}
        </div>
        {description ? <p className="mt-1.5 text-sm leading-6 text-fg-2 group-data-[orientation=horizontal]/steps:hidden md:group-data-[orientation=horizontal]/steps:block">{description}</p> : null}
        {children ? <div className="mt-3 min-w-0">{children}</div> : null}
      </div>
    </li>
  );
}

export const StepFlow = Object.assign(StepFlowRoot, { Step });
