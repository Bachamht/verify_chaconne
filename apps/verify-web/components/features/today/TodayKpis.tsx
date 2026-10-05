"use client";
import { useMemo } from "react";
import { Amount } from "@/components/kit/Amount";
import { KpiRow, StatTile } from "@/components/kit/StatTile";
import { useI18n } from "@/lib/i18n";
import type { TaskRow } from "../tasks/model";
import type { Resource } from "@/lib/useResource";
import type { PulseData, TodayData } from "./loadToday";
import { availableBudget, fillsToday, runningCount } from "./model";

/** 四个数：运行中 / 需要你 / 今日成交（只算链上确认）/ 可用预算（生效中的买入授权余额）。拿不到写「—」，不补 0 */
export function TodayKpis({ rows, data, pulse, needs, partialNeeds }: { rows: TaskRow[]; data: TodayData; pulse: Resource<PulseData>; needs: number; partialNeeds: boolean }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const at = useMemo(() => new Date(data.at), [data.at]);
  const fills = fillsToday(pulse.data?.pulses ?? null, pulse.data?.coversToday ?? false, at);
  const pulseLoading = pulse.state === "loading" || pulse.state === "idle";
  const budget = availableBudget(data.board.records, data.board.assets);
  const live = rows.filter((r) => r.mode === "LIVE" && r.group !== "ended").length;
  return (
    <KpiRow>
      <StatTile label={zh ? "运行中" : "Running"} value={runningCount(rows)} hint={zh ? `共 ${rows.length} 个任务` : `${rows.length} tasks in total`} />
      <StatTile label={zh ? "需要你" : "Needs you"} value={needs} tone={needs > 0 ? "warn" : "default"} hint={partialNeeds ? (zh ? "有任务没取到，可能不全" : "Some tasks did not load; may be incomplete") : needs > 0 ? (zh ? "见下方清单" : "See the list below") : (zh ? "暂时没有" : "Nothing right now")} />
      <StatTile label={zh ? "今日成交" : "Filled today"} value={fills} hint={fills === null ? (pulseLoading ? (zh ? "活动流读取中" : "Loading activity") : (zh ? "活动流没取全，不估算" : "Activity not fully loaded; not estimated")) : (zh ? "只算链上确认的步数" : "On-chain confirmed steps only")} />
      <StatTile
        label={zh ? "可用预算" : "Budget available"}
        value={budget ? <Amount raw={budget.raw} decimals={budget.decimals} symbol={budget.symbol} maxFrac={2} /> : null}
        hint={budget ? (zh ? `授权内剩余 · ${live} 个真实任务` : `Unspent authorized budget · ${live} live ${live === 1 ? "task" : "tasks"}`) : (zh ? "记录没拿到" : "Records not loaded")}
      />
    </KpiRow>
  );
}
