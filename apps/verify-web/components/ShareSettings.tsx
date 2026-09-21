"use client";
/** 战报分享设置：默认私密；公开时金额精确/区间/隐藏；钱包永不显示（C-02） */
import { useState } from "react";
import { shares, templates, type ShareView } from "@/lib/api-v2";
import { useI18n } from "@/lib/i18n";
import { apiError } from "@/lib/errors";
import { Card, Pill } from "@/components/ui";

export function ShareSettings({ kind, refId }: { kind: "job" | "mandate" | "simulation"; refId: string }) {
  const { t, locale } = useI18n();
  const [pub, setPub] = useState(false);
  const [amounts, setAmounts] = useState<"exact" | "range" | "hidden">("range");
  const [share, setShare] = useState<ShareView | null>(null);
  const [tplId, setTplId] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  async function save() {
    setMsg(null);
    const r = await shares.create({ kind, refId, public: pub, privacy: { amounts, wallet: "hidden" } });
    if (r.status === 200 || r.status === 201) setShare(r.data);
    else setMsg(apiError(r, locale));
  }
  async function makeTemplate() {
    const r = await templates.create({ kind: kind === "mandate" ? "plan" : "job", refId });
    if (r.status === 200 || r.status === 201) setTplId(r.data.templateId);
    else setMsg(apiError(r, locale));
  }
  const origin = typeof window === "undefined" ? "" : window.location.origin;
  return (
    <Card title={t("share_h")}>
      <div className="space-y-3 text-sm">
        <label className="flex items-center gap-2"><input type="checkbox" checked={pub} onChange={(e) => setPub(e.target.checked)} /> {t("share_public")}</label>
        <div className="flex items-center gap-2">
          <span className="text-neutral-400">{t("share_amounts")}</span>
          {(["exact", "range", "hidden"] as const).map((a) => (
            <button key={a} className={`px-2 py-0.5 text-xs ${amounts === a ? "btn" : "btn-ghost"}`} onClick={() => setAmounts(a)}>{t(`share_${a}` as "share_exact")}</button>
          ))}
        </div>
        <p className="text-xs text-neutral-500">{t("share_private_note")}</p>
        <div className="flex flex-wrap gap-2">
          <button className="btn px-3 py-1" onClick={save}>{t("share_save")}</button>
          <button className="btn-ghost px-3 py-1" onClick={makeTemplate}>{locale === "zh" ? "生成翻创模板" : "Create remix template"}</button>
        </div>
        {share && <p className="mono text-xs">{share.public ? <a className="underline" href={`/r/${share.shareId}`}>{origin}/r/{share.shareId}</a> : <Pill>{locale === "zh" ? "私密" : "private"} · {share.shareId}</Pill>}</p>}
        {tplId && <p className="mono text-xs"><a className="underline" href={`/${kind === "mandate" ? "plan" : "new"}?template=${tplId}`}>{origin}/{kind === "mandate" ? "plan" : "new"}?template={tplId}</a></p>}
        {msg && <p className="text-xs text-bad">{msg}</p>}
      </div>
    </Card>
  );
}
