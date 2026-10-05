"use client";
import { useState } from "react";
import { Share2 } from "lucide-react";
import { toast } from "sonner";
import { useI18n } from "@/lib/i18n";
import { recaps, type RecapView } from "@/lib/api-v2";
import { apiError } from "@/lib/errors";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { ConfirmDialog } from "@/components/kit/ConfirmDialog";
import { ToneTag } from "@/components/kit/StatusBadge";

type Share = { public: boolean; hideAssets: boolean; hideAmounts: boolean };

/** 分享设置（POST /v1/recaps/:id/share）：默认私密；公开视图永远不出现钱包地址 */
export function ShareDialog({ recap }: { recap: RecapView }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [cur, setCur] = useState(recap.share);
  const [s, setS] = useState<Share>({ public: recap.share.public, hideAssets: recap.share.hideAssets, hideAmounts: recap.share.hideAmounts });

  async function save() {
    setPending(true);
    const r = await recaps.share(recap.id, s).catch(() => null);
    setPending(false);
    if (r && r.status === 200) {
      setCur(r.data.share);
      setOpen(false);
      toast.success(r.data.share.public ? (zh ? "已公开这份日志" : "Journal is now public") : (zh ? "已设为私密" : "Set to private"), { description: r.data.share.publicUrl ?? undefined });
    } else toast.error(zh ? "分享设置没有保存" : "Share settings were not saved", { description: r ? apiError(r, locale) : (zh ? "服务没有回应，稍后重试。" : "The service did not answer. Retry shortly.") });
  }
  const row = (id: string, label: string, checked: boolean, on: (v: boolean) => void, disabled = false) => (
    <div className="flex items-center justify-between gap-4 py-2">
      <span className="flex min-w-0 flex-col gap-0.5">
        <Label htmlFor={id} className="text-sm text-fg-1">{label}</Label>
        {disabled ? <span id={`${id}-why`} className="text-xs text-fg-3">{zh ? "先打开「公开这份日志」才能设置" : "Turn on Make public first"}</span> : null}
      </span>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={on} aria-describedby={disabled ? `${id}-why` : undefined} />
    </div>
  );
  return (
    <>
      <span className="inline-flex items-center gap-2">
        <ToneTag tone={cur.public ? "warn" : "muted"}>{cur.public ? (zh ? "已公开" : "Public") : (zh ? "私密" : "Private")}</ToneTag>
        <Button variant="ghost" size="sm" onClick={() => { setS({ public: cur.public, hideAssets: cur.hideAssets, hideAmounts: cur.hideAmounts }); setOpen(true); }}>
          <Share2 aria-hidden="true" />{zh ? "分享设置" : "Share settings"}
        </Button>
      </span>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        tone="default"
        title={zh ? "分享这份日志" : "Share this journal"}
        consequence={zh ? "公开后任何拿到链接的人都能看到结果摘要；钱包地址永远不出现。可以隐藏资产和金额。" : "Anyone with the link sees the result summary; the wallet address never appears. You can hide assets and amounts."}
        confirmLabel={zh ? "保存分享设置" : "Save share settings"}
        pending={pending}
        onConfirm={() => void save()}
      >
        <div className="flex flex-col divide-y divide-line">
          {row("share-public", zh ? "公开这份日志" : "Make this journal public", s.public, (v) => setS({ ...s, public: v }))}
          {row("share-assets", zh ? "隐藏资产" : "Hide assets", s.hideAssets, (v) => setS({ ...s, hideAssets: v }), !s.public)}
          {row("share-amounts", zh ? "隐藏金额" : "Hide amounts", s.hideAmounts, (v) => setS({ ...s, hideAmounts: v }), !s.public)}
        </div>
      </ConfirmDialog>
    </>
  );
}
