"use client";
/** 「Agent 会怎么做」：每个命中的未结束任务一条：任务名 + StatusBadge + 一句人话 + 窗口状态。 */
import Link from "next/link";
import { StatusBadge } from "@/components/kit/StatusBadge";
import { Timestamp } from "@/components/kit/Timestamp";
import { ErrorState, LoadingBlock, SkeletonRows } from "@/components/kit/FourStates";
import { useI18n } from "@/lib/i18n";
import { copy } from "./copy";
import { ruleSentence, windowPhase, type HitRule, type TaskHit } from "./impact";

function WindowLine({ rule, nowMs }: { rule: HitRule; nowMs: number }) {
  const { locale } = useI18n();
  const c = copy(locale);
  if (rule.kind !== "avoid" || !rule.window) return null;
  const phase = windowPhase(rule.window, nowMs);
  if (phase === "over") return <p className="mt-0.5 text-xs text-fg-3">{c("window_over")}</p>;
  return (
    <p className={phase === "active" ? "mt-0.5 text-xs text-warn" : "mt-0.5 text-xs text-fg-3"}>
      {phase === "active" ? c("window_active") : c("window_upcoming")} <Timestamp at={phase === "active" ? rule.window.endMs : rule.window.startMs} mode="both" />
    </p>
  );
}

export function HitList({ hits, nowMs, tasksStatus, onRetry, closedCount }: {
  hits: TaskHit[] | null;
  nowMs: number;
  tasksStatus: { state: string; status: number | null };
  onRetry: () => void;
  closedCount: number | null;
}) {
  const { locale } = useI18n();
  const c = copy(locale);
  if (tasksStatus.state === "error") return <ErrorState size="sm" status={tasksStatus.status ?? 0} title={locale === "zh" ? "任务没有读到，算不出影响" : "Tasks were not returned, so impact cannot be worked out"} onRetry={onRetry} />;
  if (hits === null) return <LoadingBlock shape={<SkeletonRows rows={2} />} onRetry={onRetry} />;
  return (
    <div className="flex flex-col gap-2">
      {hits.length === 0 ? <p className="text-sm text-fg-2">{c("hits_none")}</p> : (
        <ul className="flex flex-col divide-y divide-line">
          {hits.map((h) => (
            <li key={h.task.id} className="flex min-w-0 flex-col gap-1 py-3 first:pt-0">
              <div className="flex min-w-0 items-start justify-between gap-3">
                <Link href={`/agent/tasks/${h.task.id}`} className="min-w-0 truncate text-sm font-medium text-fg-1 hover:text-brand-300" title={h.task.title}>{h.task.title}</Link>
                <StatusBadge status={h.task.status} />
              </div>
              {h.rules.map((r, i) => (
                <div key={i}>
                  <p className="text-sm text-fg-2">{ruleSentence(r, locale)}</p>
                  <WindowLine rule={r} nowMs={nowMs} />
                </div>
              ))}
            </li>
          ))}
        </ul>
      )}
      {closedCount ? <p className="text-xs text-fg-3">{c("hits_skipped")}{locale === "zh" ? `（${closedCount} 个）` : ` (${closedCount})`}</p> : null}
    </div>
  );
}
