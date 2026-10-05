"use client";
import type { Blocker } from "@chaconne/core/verify";
import { CircleCheck } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { Blockers, type BlockerItem } from "@/components/kit/Blockers";
import { Timestamp } from "@/components/kit/Timestamp";

/**
 * 诊断用的阻塞项列表：kit Blockers + 每项 meta（证据时间、下次检查（缺值写「未知」）、证据条数）。
 * 文案优先用服务端按 locale 给的 i18n，其次 lib/reasons；未映射的码不露原文（kit blockerText 兜底）。
 */
export function BlockerEvidenceList({ blockers, i18n, evaluatedAt, fallbackEvidenceAt }: {
  blockers: Blocker[];
  i18n?: Array<{ code: string; en: string; zh: string }>;
  evaluatedAt: string;
  fallbackEvidenceAt: string | null;
}) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const items: BlockerItem[] = blockers.map((b) => {
    const api = i18n?.find((x) => x.code === b.code);
    const ev = b.evidenceAt ?? fallbackEvidenceAt;
    const n = b.evidenceIds?.length ?? 0;
    return {
      code: b.code,
      text: api ? api[locale] : null,
      needsYou: !!b.userActionRequired,
      meta: (
        <span className="flex flex-wrap gap-x-4 gap-y-0.5">
          <span>{zh ? "证据时间 · " : "Evidence at · "}{ev ? <Timestamp at={ev} mode="abs" /> : <>{zh ? "未知（评估于 " : "Unknown (evaluated "}<Timestamp at={evaluatedAt} mode="abs" />{zh ? "）" : ")"}</>}</span>
          <span>{zh ? "下次检查 · " : "Next check · "}{b.nextCheckAt ? <Timestamp at={b.nextCheckAt} mode="both" /> : (zh ? "未知" : "Unknown")}</span>
          {n > 0 ? <span className="tabular-nums">{zh ? `${n} 条证据` : `${n} evidence record(s)`}</span> : null}
        </span>
      ),
    };
  });
  return (
    <Blockers
      items={items}
      hideNextCheck
      empty={<p className="flex items-center gap-2 py-2 text-sm text-ok"><CircleCheck className="size-4" aria-hidden="true" />{zh ? "没有阻塞项：这次评估全部条件满足。" : "No blockers: every condition passed in this evaluation."}</p>}
    />
  );
}
