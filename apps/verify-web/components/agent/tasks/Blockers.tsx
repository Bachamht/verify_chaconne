"use client";
/** 阻塞项列表（V-32）：每项一句本地化短句 + 证据时间（本地时间）+ 已知下次检查；原始码只进开发者视图。PAUSED 时不显示下次检查。 */
import type { Blocker } from "@chaconne/core/verify";
import { useI18n } from "@/lib/i18n";
import { formatTime } from "@/lib/format";
import { Pill } from "@/components/ui";
import { blockerSentence } from "./taskTitle";

export function Blockers({ blockers, nextCheckAt, paused = false, userActionRequired }: { blockers: Blocker[]; nextCheckAt: string | null; paused?: boolean; userActionRequired?: boolean }) {
  const { locale, t } = useI18n();
  const zh = locale === "zh";
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-fg-3">{t("ag_blockers")} · {blockers.length}</p>
      {blockers.length === 0 ? <p className="ag-note">{t("ag_no_blockers")}</p> : (
        <ul className="ag-list">{blockers.map((b, i) => (
          <li key={`${b.code}-${i}`}>
            <p className="text-sm">{blockerSentence(b, locale)}{b.userActionRequired && <> <Pill tone="warn">{zh ? "需要你决定" : "needs you"}</Pill></>}</p>
            <p className="ag-note">{zh ? "证据时间" : "Evidence at"} {b.evidenceAt ? formatTime(b.evidenceAt, locale) : (zh ? "未知" : "unknown")}{!paused && b.nextCheckAt ? ` · ${t("ag_next_check")} ${formatTime(b.nextCheckAt, locale)}` : ""}</p>
          </li>
        ))}</ul>
      )}
      {paused
        ? <p className="ag-note">{zh ? "已暂停：不签发证书，也不安排下次检查；点「继续」恢复。" : "Paused: no certificate is issued and no next check is scheduled; press Resume to continue."}</p>
        : <p className="ag-note">{t("ag_next_check")}: {nextCheckAt ? formatTime(nextCheckAt, locale) : (zh ? "未知（没有任何一项有已知恢复点）" : "unknown (no item has a known recovery time)")}{userActionRequired ? ` · ${zh ? "有需要你决定的项" : "some items need your decision"}` : ""}</p>}
    </div>
  );
}
