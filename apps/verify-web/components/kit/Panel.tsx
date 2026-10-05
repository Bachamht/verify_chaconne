import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * 数据区块容器：轻描边与宽松留白，标题、说明和数据各有层级。
 * 复合组件：<Panel><Panel.Header title=… action=…/><Panel.Body>…</Panel.Body><Panel.Footer/></Panel>
 */
function PanelRoot({ children, className, tone = "default", id, as: As = "section", "aria-label": ariaLabel }: {
  children: ReactNode;
  className?: string;
  /** warn：需要你处理（surface-warn 底） */
  tone?: "default" | "warn" | "brand";
  id?: string;
  as?: "section" | "div" | "article";
  "aria-label"?: string;
}) {
  return (
    <As id={id} aria-label={ariaLabel} className={cn(
      "ch-panel flex min-w-0 flex-col rounded-lg border",
      tone === "warn" ? "border-warn/35 bg-surface-warn" : tone === "brand" ? "border-line-brand bg-surface-brand" : "bg-card",
      className,
    )}>
      {children}
    </As>
  );
}

function PanelHeader({ title, description, action, eyebrow, className, level = 2 }: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  /** 小标题（编号 / 来源），12px */
  eyebrow?: ReactNode;
  className?: string;
  level?: 2 | 3;
}) {
  const H = level === 2 ? "h2" : "h3";
  return (
    <header className={cn("ch-panel-header flex min-w-0 flex-col items-start justify-between gap-x-5 gap-y-3 px-5 pt-5 pb-4 sm:flex-row sm:px-6 sm:pt-6", className)}>
      <div className="w-full min-w-0 sm:w-auto sm:flex-1">
        {eyebrow ? <p className="mb-2 text-xs font-medium tracking-wider text-fg-3 uppercase">{eyebrow}</p> : null}
        <H className="text-md font-medium tracking-tight text-fg-1">{title}</H>
        {description ? <p className="mt-1.5 text-sm leading-6 text-fg-2">{description}</p> : null}
      </div>
      {action ? <div className="flex shrink-0 items-center gap-2">{action}</div> : null}
    </header>
  );
}

function PanelBody({ children, className, flush = false }: { children: ReactNode; className?: string; flush?: boolean }) {
  return <div className={cn("min-w-0", flush ? "" : "px-5 pb-5 sm:px-6 sm:pb-6", className)}>{children}</div>;
}

function PanelFooter({ children, className }: { children: ReactNode; className?: string }) {
  return <footer className={cn("flex flex-wrap items-center gap-2 border-t px-5 py-4 sm:px-6", className)}>{children}</footer>;
}

export const Panel = Object.assign(PanelRoot, { Header: PanelHeader, Body: PanelBody, Footer: PanelFooter });
