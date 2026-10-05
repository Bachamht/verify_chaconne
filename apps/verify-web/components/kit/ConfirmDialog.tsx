"use client";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useI18n } from "@/lib/i18n";
import { AsyncButton } from "./AsyncButton";

/**
 * 破坏性 / 不可逆操作的二次确认（C4）：标题说动作，正文说后果，确认按钮写后果（「取消任务」而非「确认」）。
 * 暂停、取消、收回额度、链上撤销是四种不同操作——每种用自己的文案，不要共用一句。
 */
export function ConfirmDialog({ open, onOpenChange, title, consequence, confirmLabel, onConfirm, pending = false, tone = "danger", children }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  consequence: ReactNode;
  confirmLabel: ReactNode;
  onConfirm: () => void;
  pending?: boolean;
  tone?: "danger" | "default";
  children?: ReactNode;
}) {
  const { locale } = useI18n();
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!pending) onOpenChange(o); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="text-sm text-fg-2">{consequence}</DialogDescription>
        </DialogHeader>
        {children}
        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>{locale === "zh" ? "先不" : "Not now"}</Button>
          <AsyncButton variant={tone === "danger" ? "destructive" : "default"} pending={pending} onClick={onConfirm}>{confirmLabel}</AsyncButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
