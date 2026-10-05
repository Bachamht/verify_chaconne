import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** 页面标题区：清晰的大标题 + 舒展的说明 + 右侧动作；可带徽章行与面包屑。一页只有一个 h1。 */
export function PageHeader({ title, description, actions, badges, breadcrumb, className }: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  badges?: ReactNode;
  breadcrumb?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("ch-page-header mb-8 flex min-w-0 flex-col gap-3", className)}>
      {breadcrumb ? <div className="text-xs leading-5 text-fg-3">{breadcrumb}</div> : null}
      <div className="flex min-w-0 flex-col items-start justify-between gap-x-8 gap-y-4 sm:flex-row">
        <div className="w-full min-w-0 sm:w-auto sm:flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h1 className="min-w-0 text-[1.75rem] leading-tight font-medium tracking-[-0.035em] break-words text-fg-1 sm:text-[2rem]">{title}</h1>
            {badges}
          </div>
          {description ? <p className="mt-2 max-w-3xl text-sm leading-6 text-fg-2">{description}</p> : null}
        </div>
        {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
    </div>
  );
}
