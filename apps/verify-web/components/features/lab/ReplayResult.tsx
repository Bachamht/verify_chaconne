"use client";
import { useState } from "react";
import { useI18n } from "@/lib/i18n";
import type { ReplayView } from "@/components/agent/lab/api";
import { hasReasonText } from "@/lib/reasons";
import { Panel } from "@/components/kit/Panel";
import { Blockers } from "@/components/kit/Blockers";
import { ToneTag } from "@/components/kit/StatusBadge";
import { Timestamp } from "@/components/kit/Timestamp";
import { gapLabel, outcomeMeta, replayCounts, sourceCount } from "./labText";
import { ReplayBar } from "./ReplayBar";

/** 回放结果：三色计数 → 回放条（hover 说明）→ 选中点的阻塞项 → 覆盖与缺口（如实）→ 用到的数据量 */
export function ReplayResult({ d }: { d: ReplayView }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const run = d.run;
  const [sel, setSel] = useState<number | null>(null);
  const counts = replayCounts(run.points);
  const p = sel !== null ? run.points[sel] : null;
  const n = (v: unknown) => sourceCount(v, locale);
  return (
    <Panel>
      <Panel.Header title={zh ? `回放结果 · ${run.points.length} 个评估点` : `Replay · ${run.points.length} points`} description={zh ? d.note?.zh : d.note?.en} />
      <Panel.Body className="flex flex-col gap-4">
        <div className="flex flex-wrap gap-2">
          {(["SATISFIED", "UNSATISFIED", "INSUFFICIENT_EVIDENCE"] as const).map((o) => { const m = outcomeMeta(o, locale); return <ToneTag key={o} tone={m.tone}>{m.label} {counts[o]}</ToneTag>; })}
          <ToneTag tone="muted">{zh ? "缺口" : "Gaps"} {run.gaps.length}</ToneTag>
        </div>
        {run.points.length === 0 ? (
          <p className="text-sm text-fg-3">{zh ? "这段时间没有评估点：没有存档的数据。换一段时间试试。" : "No evaluation points: nothing was archived in this range. Try another range."}</p>
        ) : <ReplayBar run={run} selected={sel} onSelect={setSel} />}
        {p ? (
          <div className="rounded-md border bg-surface-2 px-4 py-3">
            <p className="flex flex-wrap items-center gap-2 text-sm text-fg-1">
              <ToneTag tone={outcomeMeta(p.outcome, locale).tone}>{outcomeMeta(p.outcome, locale).label}</ToneTag>
              <Timestamp at={p.t} mode="abs" />
              <span className="text-xs text-fg-3">{zh ? "用到的最晚可知时刻 " : "Known as of "}<Timestamp at={p.knownAsOf} mode="abs" /></span>
            </p>
            <Blockers className="mt-1" items={p.blockers.map((b) => ({ code: b.code, text: hasReasonText(b.code) || !b.text || /^[A-Z0-9_]+$/.test(b.text) ? null : b.text }))} empty={<p className="mt-1 text-sm text-fg-3">{zh ? "这个点没有阻塞项。" : "No blockers at this point."}</p>} hideNextCheck />
          </div>
        ) : run.points.length > 0 ? <p className="text-xs text-fg-3">{zh ? "悬停看每一段的说明，点一下看那个时点的阻塞项。" : "Hover a segment for its summary; click it to see that point's blockers."}</p> : null}
        <div className="grid min-w-0 gap-4 text-sm md:grid-cols-2">
          <div className="min-w-0">
            <h3 className="mb-1 text-sm font-medium text-fg-1">{zh ? "覆盖区间" : "Coverage"}</h3>
            {run.coverage.length === 0 ? <p className="text-fg-3">{zh ? "没有任何覆盖：这段时间没有存档。" : "No coverage: nothing archived in this range."}</p> : (
              <ul className="flex flex-col gap-1 text-xs text-fg-2">{run.coverage.map((c, i) => <li key={i}><Timestamp at={c.from} mode="abs" /> → <Timestamp at={c.to} mode="abs" /> · <span className="text-fg-3">{c.sources.length} {zh ? "个来源" : "source(s)"}</span></li>)}</ul>
            )}
          </div>
          <div className="min-w-0">
            <h3 className="mb-1 text-sm font-medium text-fg-1">{zh ? "缺口（如实）" : "Gaps (as found)"}</h3>
            {run.gaps.length === 0 ? <p className="text-fg-3">{zh ? "没有缺口。" : "No gaps."}</p> : (
              <ul className="flex flex-col gap-1 text-xs text-fg-2">{run.gaps.map((g, i) => <li key={i}><Timestamp at={g.from} mode="abs" /> → <Timestamp at={g.to} mode="abs" /> · {gapLabel(g.reason, locale)}</li>)}</ul>
            )}
          </div>
        </div>
        <p className="text-xs text-fg-3 tabular-nums">
          {zh
            ? `用到的数据：证据 ${n(d.sources?.verify_evidence)} 条 · 上下文快照 ${n(d.sources?.verify_context_snapshots)} 份 · 溢价小时线 ${n(d.sources?.premium_1h)} 条（只作背景）· 事件 ${n(d.sources?.events)} 个`
            : `Data used: ${n(d.sources?.verify_evidence)} evidence record(s) · ${n(d.sources?.verify_context_snapshots)} context snapshot(s) · ${n(d.sources?.premium_1h)} hourly premium point(s) (background only) · ${n(d.sources?.events)} event(s)`}
        </p>
      </Panel.Body>
    </Panel>
  );
}
