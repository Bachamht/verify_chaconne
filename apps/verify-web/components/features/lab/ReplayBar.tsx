"use client";
import type { ReplayRun } from "@chaconne/core/verify";
import { useI18n } from "@/lib/i18n";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Timestamp } from "@/components/kit/Timestamp";
import { cn } from "@/lib/utils";
import { gapLabel, outcomeMeta, spanPct } from "./labText";

const FILL: Record<string, string> = { SATISFIED: "fill-ok", UNSATISFIED: "fill-warn", INSUFFICIENT_EVIDENCE: "fill-info" };

/**
 * 回放条（沿用旧版的三色评估点 + 灰色缺口带）：SVG 百分比坐标（不写内联样式），每段 hover / 聚焦出 Tooltip 说明，点击选中看详情。
 */
export function ReplayBar({ run, selected, onSelect }: { run: ReplayRun; selected: number | null; onSelect: (i: number) => void }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <svg className="h-8 w-full overflow-hidden rounded-md bg-surface-0" role="group" aria-label={zh ? "评估点" : "Evaluation points"}>
        {run.points.map((p, i) => {
          const { x, w } = spanPct(p.t, run.points[i + 1]?.t ?? run.to, run.from, run.to);
          const m = outcomeMeta(p.outcome, locale);
          return (
            <Tooltip key={p.t}>
              <TooltipTrigger asChild>
                <rect
                  x={`${x}%`} y="0" width={`${w}%`} height="100%"
                  role="button" tabIndex={0}
                  aria-label={`${m.label} · ${new Date(p.t).toLocaleString(zh ? "zh-CN" : "en-US")}`}
                  aria-pressed={selected === i}
                  className={cn(FILL[p.outcome] ?? "fill-fg-3", "cursor-pointer outline-none hover:opacity-80 focus-visible:opacity-70", selected === i && "stroke-fg-1 stroke-2")}
                  onClick={() => onSelect(i)}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onSelect(i); } }}
                />
              </TooltipTrigger>
              <TooltipContent className="max-w-72">
                <p className="font-medium">{m.label} · <Timestamp at={p.t} mode="abs" /></p>
                <p className="text-fg-2">{p.blockers.length === 0 ? (zh ? "没有阻塞项" : "No blockers") : (zh ? `${p.blockers.length} 个阻塞项，点开看详情` : `${p.blockers.length} blocker(s); click for details`)}</p>
              </TooltipContent>
            </Tooltip>
          );
        })}
      </svg>
      <svg className="h-3 w-full overflow-hidden rounded-sm bg-surface-1" role="group" aria-label={zh ? "数据缺口" : "Data gaps"}>
        {run.gaps.map((g, i) => {
          const { x, w } = spanPct(g.from, g.to, run.from, run.to);
          return (
            <Tooltip key={`${g.reason}-${i}`}>
              <TooltipTrigger asChild>
                <rect x={`${x}%`} y="0" width={`${w}%`} height="100%" role="img" tabIndex={0} className="fill-line-strong outline-none hover:fill-fg-3 focus-visible:fill-fg-3" aria-label={gapLabel(g.reason, locale)} />
              </TooltipTrigger>
              <TooltipContent className="max-w-72">
                <p className="font-medium">{gapLabel(g.reason, locale)}</p>
                <p className="text-fg-2"><Timestamp at={g.from} mode="abs" /> → <Timestamp at={g.to} mode="abs" /></p>
              </TooltipContent>
            </Tooltip>
          );
        })}
      </svg>
      <div className="flex justify-between text-xs text-fg-3">
        <Timestamp at={run.from} mode="abs" />
        <Timestamp at={run.to} mode="abs" />
      </div>
    </div>
  );
}
