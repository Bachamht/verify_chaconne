"use client";
import { Blockers, type BlockerItem } from "@/components/kit/Blockers";
import { Panel } from "@/components/kit/Panel";
import { useI18n } from "@/lib/i18n";
import { reasonOverride, severityLevel } from "./labels";

/** 报告理由：按报告给的严重度分级（拦住 / 注意 / 提示）；同码同级去重（服务端会因多条证据重复给同一原因）；原码只在 title 里 */
export function toBlockerItems(reasons: Array<{ code: string; severity: string }>, locale: "zh" | "en"): BlockerItem[] {
  const seen = new Set<string>();
  const out: BlockerItem[] = [];
  for (const r of reasons) {
    const k = `${r.code}:${r.severity}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ code: r.code, level: severityLevel(r.severity), text: reasonOverride(r.code, locale), needsYou: false });
  }
  return out;
}

export function ReasonList({ reasons, title }: { reasons: Array<{ code: string; severity: string }>; title?: string }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const items = toBlockerItems(reasons, locale);
  const blocks = items.filter((r) => r.level === "block").length;
  return (
    <Panel aria-label={title ?? (zh ? "原因与提示" : "Reasons")}>
      <Panel.Header
        title={title ?? (zh ? "原因与提示" : "Reasons and notes")}
        description={blocks > 0 ? (zh ? `${blocks} 项拦住了执行，其余是提示。` : `${blocks} item(s) blocked execution; the rest are notes.`) : (zh ? "没有拦住执行的项。" : "Nothing blocked execution.")}
      />
      <Panel.Body className="pb-3">
        <Blockers items={items} empty={<p className="py-2 text-sm text-fg-2">{zh ? "报告没有返回额外原因。" : "The report returned no additional reasons."}</p>} />
      </Panel.Body>
    </Panel>
  );
}
