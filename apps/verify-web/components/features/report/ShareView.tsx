"use client";
/**
 * 分享（C-02）：默认私密；公开时金额精确 / 区间 / 隐藏；钱包地址永不显示。
 * 复用模板（V-38）：接的是真实接口 POST /v1/templates（服务端 club.createTemplate 收 {kind, refId}）。
 * 只在有可复用对象时出现：核验 → kind "job"；授权任务 → 它来自的规划 kind "plan"。没有就不渲染按钮，不留无效按钮。
 */
import { useState } from "react";
import { Copy } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { AsyncButton } from "@/components/kit/AsyncButton";
import { Panel } from "@/components/kit/Panel";
import { shares, templates, type ShareView as ShareResult } from "@/lib/api-v2";
import { apiError } from "@/lib/errors";
import { useI18n } from "@/lib/i18n";

type Amounts = "exact" | "range" | "hidden";

async function copyText(text: string, zh: boolean) {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(zh ? "已复制" : "Copied");
  } catch {
    toast.error(zh ? "复制失败，请手动选择链接" : "Copy failed. Select the link manually.");
  }
}

export function ShareView({ kind, refId, template }: { kind: "job" | "mandate" | "simulation"; refId: string; template?: { kind: "job" | "plan"; refId: string } | null }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const [pub, setPub] = useState(false);
  const [amounts, setAmounts] = useState<Amounts>("range");
  const [saving, setSaving] = useState(false);
  const [share, setShare] = useState<ShareResult | null>(null);
  const [making, setMaking] = useState(false);
  const [tplId, setTplId] = useState<string | null>(null);
  const origin = typeof window === "undefined" ? "" : window.location.origin;

  async function save() {
    setSaving(true);
    try {
      const r = await shares.create({ kind, refId, public: pub, privacy: { amounts, wallet: "hidden" } });
      if (r.status === 200 || r.status === 201) {
        setShare(r.data);
        toast.success(r.data.public ? (zh ? "已公开，链接在下方" : "Shared publicly. The link is below.") : (zh ? "已保存为私密" : "Saved as private"));
      } else toast.error(apiError(r, locale));
    } finally {
      setSaving(false);
    }
  }
  async function makeTemplate() {
    if (!template) return;
    setMaking(true);
    try {
      const r = await templates.create(template);
      if ((r.status === 200 || r.status === 201) && r.data?.templateId) {
        setTplId(r.data.templateId);
        toast.success(zh ? "复用模板已生成" : "Template created");
      } else toast.error(apiError(r, locale));
    } finally {
      setMaking(false);
    }
  }
  const shareHref = share?.public ? `${origin}/r/${share.shareId}` : null;
  const tplHref = tplId && template ? `${origin}/${template.kind === "plan" ? "plan" : "new"}?template=${tplId}` : null;

  return (
    <Panel>
      <Panel.Header title={zh ? "分享" : "Share"} description={zh ? "默认私密，钱包地址永不显示。" : "Private by default. Your wallet is never shown."} />
      <Panel.Body className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor={`share-pub-${refId}`} className="text-sm text-fg-1">{zh ? "公开到战报页" : "Publish as a public report"}</Label>
          <Switch id={`share-pub-${refId}`} checked={pub} onCheckedChange={setPub} />
        </div>
        <div className="flex items-center justify-between gap-3">
          <Label htmlFor={`share-amt-${refId}`} className="text-sm text-fg-1">{zh ? "公开时金额显示" : "Amounts when public"}</Label>
          <Select value={amounts} onValueChange={(v) => setAmounts(v as Amounts)}>
            <SelectTrigger id={`share-amt-${refId}`} className="w-36"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="exact">{zh ? "精确金额" : "Exact"}</SelectItem>
              <SelectItem value="range">{zh ? "只给区间" : "Range only"}</SelectItem>
              <SelectItem value="hidden">{zh ? "隐藏" : "Hidden"}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {shareHref ? <ResultLink href={shareHref} label={zh ? "公开链接" : "Public link"} zh={zh} /> : share ? <p className="text-sm text-fg-2" role="status">{zh ? "已保存：仅自己可见。" : "Saved: visible only to you."}</p> : null}
        {tplHref ? <ResultLink href={tplHref} label={zh ? "复用链接（只带资产、策略与限额，不带金额与钱包）" : "Reuse link (assets, policy and limits only; no amounts or wallet)"} zh={zh} /> : null}
      </Panel.Body>
      <Panel.Footer>
        <AsyncButton size="sm" pending={saving} pendingLabel={zh ? "正在保存…" : "Saving…"} onClick={() => void save()}>{zh ? "保存分享设置" : "Save share settings"}</AsyncButton>
        {template ? <AsyncButton size="sm" variant="ghost" pending={making} pendingLabel={zh ? "正在生成…" : "Creating…"} onClick={() => void makeTemplate()}>{zh ? "生成复用模板" : "Create a reuse template"}</AsyncButton> : null}
      </Panel.Footer>
    </Panel>
  );
}

function ResultLink({ href, label, zh }: { href: string; label: string; zh: boolean }) {
  return (
    <div className="flex min-w-0 flex-col gap-1" role="status">
      <span className="text-xs text-fg-3">{label}</span>
      <span className="flex min-w-0 items-center gap-2">
        <a className="min-w-0 truncate font-mono text-xs text-brand-300 hover:text-brand-200" href={href} title={href} translate="no">{href}</a>
        <Button size="icon" variant="ghost" className="size-7 shrink-0" onClick={() => void copyText(href, zh)} aria-label={zh ? "复制链接" : "Copy link"}><Copy className="size-3.5" aria-hidden="true" /></Button>
      </span>
    </div>
  );
}
