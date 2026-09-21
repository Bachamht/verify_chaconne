"use client";
/** /me（V-10）：本浏览器创建过的核验/规划/授权/模拟，倒序；只存本地。 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { clearHistory, forget, history, hrefFor, type HistoryItem } from "@/lib/history";
import { fmtLocal } from "@/lib/format";
import { Card, Pill } from "@/components/ui";

const KIND_TONE: Record<HistoryItem["kind"], "ok" | "warn" | "brand" | "neutral"> = { job: "ok", plan: "brand", mandate: "warn", simulation: "neutral" };

export function MyTasks() {
  const { t, locale } = useI18n();
  const [items, setItems] = useState<HistoryItem[]>([]);
  useEffect(() => {
    const load = () => setItems(history());
    load();
    window.addEventListener("verify:history", load);
    return () => window.removeEventListener("verify:history", load);
  }, []);
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">{t("me_h")}</h1>
      <p className="text-sm text-neutral-400">{t("me_p")}</p>
      <Card>
        {items.length === 0 ? (
          <div className="space-y-3 text-sm text-neutral-300">
            <p>{t("me_empty")}</p>
            <div className="flex flex-wrap gap-2">
              <Link href="/new" className="btn">{t("nav_new")}</Link>
              <Link href="/plan" className="btn-ghost">{t("nav_plan")}</Link>
              <Link href="/play" className="btn-ghost">{t("nav_play")}</Link>
            </div>
          </div>
        ) : (
          <ul className="divide-y divide-neutral-800 text-sm">
            {items.map((it) => (
              <li key={`${it.kind}:${it.id}`} className="flex flex-wrap items-center gap-3 py-2">
                <Pill tone={KIND_TONE[it.kind]}>{t(`me_kind_${it.kind}` as "me_kind_job")}</Pill>
                <Link href={hrefFor(it)} className="min-w-0 flex-1 truncate underline">{it.title || it.id}</Link>
                <span className="mono text-xs text-neutral-500">{fmtLocal(it.createdAt, locale)}</span>
                <button className="btn-ghost px-2 py-0.5 text-xs" aria-label="remove" onClick={() => forget(it.kind, it.id)}>×</button>
              </li>
            ))}
          </ul>
        )}
        {items.length > 0 && (
          <div className="mt-3 text-right">
            <button className="btn-ghost px-3 py-1 text-xs" onClick={() => clearHistory()}>{t("me_clear")}</button>
          </div>
        )}
      </Card>
    </div>
  );
}
