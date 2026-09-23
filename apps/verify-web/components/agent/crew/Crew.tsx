"use client";
/** Crew：四个角色只复述真实响应字段（R-01）；没有数据的角色显示「今晚没动作」而不是编一句。 */
import { Binoculars, ClipboardCheck, Music2, Ruler } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { linesFor, type CrewRole } from "./lines";

const ROLES: Array<{ id: CrewRole; icon: typeof Binoculars; name: { en: string; zh: string }; job: { en: string; zh: string } }> = [
  { id: "scout", icon: Binoculars, name: { en: "Scout", zh: "瞭望员" }, job: { en: "context & events", zh: "上下文与事件" } },
  { id: "planner", icon: Ruler, name: { en: "Planner", zh: "规划员" }, job: { en: "plan & compare", zh: "规划与对照" } },
  { id: "player", icon: Music2, name: { en: "Player", zh: "演奏员" }, job: { en: "execute (agent-wallet / browser)", zh: "执行（agent-wallet 或浏览器）" } },
  { id: "auditor", icon: ClipboardCheck, name: { en: "Auditor", zh: "审计员" }, job: { en: "evidence bundle checks", zh: "证据包验证" } },
];

export function Crew({ data }: { data: Record<string, unknown> }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  return (
    <div className="ag-crew">
      {ROLES.map((r) => {
        const Icon = r.icon;
        const lines = linesFor(r.id, data, locale);
        return (
          <article key={r.id} className="ag-crew-card" aria-label={r.name[locale]}>
            <div className="ag-crew-role"><Icon size={16} aria-hidden="true" />{r.name[locale]}<span className="mono">{r.job[locale]}</span></div>
            {lines.length ? lines.map((l, i) => <p key={i} className="ag-crew-line">{l}</p>) : <p className="ag-crew-line" data-empty="1">{zh ? "今晚还没有可复述的动作。" : "Nothing real to report yet tonight."}</p>}
          </article>
        );
      })}
    </div>
  );
}
