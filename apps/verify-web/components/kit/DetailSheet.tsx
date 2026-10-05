"use client";
import type { ReactNode } from "react";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

/**
 * 列表 → 详情抽屉（components.md「Drawer」）：右侧 Sheet，宽 480 / 640；必有标题。
 * URL 同步由调用方用 useQueryParam("id") 完成（刷新可恢复，C5）。
 */
export function DetailSheet({ open, onOpenChange, title, description, badges, footer, width = "md", children }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  badges?: ReactNode;
  footer?: ReactNode;
  width?: "md" | "lg";
  children: ReactNode;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className={cn("flex w-full flex-col gap-0 bg-popover p-0", width === "lg" ? "sm:max-w-160" : "sm:max-w-120")}>
        <SheetHeader className="border-b px-5 py-4 pr-12">
          <SheetTitle className="text-md font-semibold text-fg-1">{title}</SheetTitle>
          {badges ? <div className="flex flex-wrap gap-1.5">{badges}</div> : null}
          {description ? <SheetDescription className="text-sm text-fg-2">{description}</SheetDescription> : <SheetDescription className="sr-only">{typeof title === "string" ? title : ""}</SheetDescription>}
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer ? <SheetFooter className="flex-row flex-wrap gap-2 border-t px-5 py-3">{footer}</SheetFooter> : null}
      </SheetContent>
    </Sheet>
  );
}
