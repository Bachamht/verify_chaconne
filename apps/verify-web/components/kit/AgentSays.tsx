import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Agent 的一句话判断：低饱和品牌底、细引线、易读的正文和独立来源行。
 * 工作区里 Agent 发言一律用它，不用吉祥物头像。长段落中英混排：break-words + 合理行宽。
 */
export function AgentSays({ children, who, meta, source, className }: {
  children: ReactNode;
  /** 发言者，默认「Agent」 */
  who?: ReactNode;
  /** 右上角的时间等（<Timestamp/>） */
  meta?: ReactNode;
  /** 来源 chip（点开是证据） */
  source?: ReactNode;
  className?: string;
}) {
  return (
    <figure className={cn("ch-agent-says min-w-0 rounded-md border-l-2 border-l-brand-400 bg-surface-brand px-5 py-4 sm:px-6 sm:py-5", className)}>
      {(who || meta) && (
        <figcaption className="mb-3 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs leading-5 text-fg-3">
          <span className="font-medium text-brand-300">{who ?? "Agent"}</span>
          {meta ? <span className="shrink-0">{meta}</span> : null}
        </figcaption>
      )}
      <blockquote className="text-base leading-7 break-words whitespace-pre-line text-fg-1 [overflow-wrap:anywhere]">{children}</blockquote>
      {source ? <div className="mt-4 flex flex-wrap gap-2">{source}</div> : null}
    </figure>
  );
}

/** 来源 chip：AgentSays / 理由卡里的引用 */
export function SourceChip({ children, href, onClick }: { children: ReactNode; href?: string; onClick?: () => void }) {
  const cls = "inline-flex min-h-7 items-center gap-1 rounded-md border border-line bg-surface-2 px-2.5 py-1 text-xs text-fg-2 transition-colors hover:border-brand-400 hover:text-fg-1";
  if (href) return <a className={cls} href={href}>{children}</a>;
  if (onClick) return <button type="button" className={cls} onClick={onClick}>{children}</button>;
  return <span className={cls}>{children}</span>;
}
