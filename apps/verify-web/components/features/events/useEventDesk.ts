"use client";
/**
 * 事件台数据：日历 → 任务 → 浏览器内命中（毫秒级）；服务端影响清单在后台补，不挡首屏。
 * 派生值都在渲染期算（rerender-derived-state-no-effect）。
 */
import { useDeferredValue, useMemo } from "react";
import type { MarketEvent } from "@chaconne/core/verify";
import type { Locale } from "@/lib/i18n";
import { agentTasks } from "@/lib/api-v2";
import { loadAssets, type AssetEntry } from "@/lib/assets";
import { useResource } from "@/lib/useResource";
import { useNow } from "@/components/kit/useNow";
import { eventsApi } from "./api";
import { inHorizon, queryRange } from "./eventText";
import { latestWindowEnd, matchEvent, openTasks, type TaskHit } from "./impact";

export interface EventRowData {
  ev: MarketEvent;
  /** 事件直接相关的资产（underlyingIds → 登记表） */
  assets: AssetEntry[];
  /** null = 任务还没读到 / 没读到；[] = 读到了、没有命中 */
  hits: TaskHit[] | null;
}

const MINUTE = 60_000;

export function useEventDesk(owner: string, hours: number, locale: Locale) {
  // 「现在」按分钟取整，每分钟走一次：范围与窗口状态跟着变，渲染之间不抖动
  const tick = useNow(MINUTE);
  const nowMs = Math.floor((tick?.getTime() ?? Date.now()) / MINUTE) * MINUTE;
  const { from, to } = queryRange(nowMs, hours);
  const calendar = useResource(`events:${from}:${to}`, () => eventsApi.calendar(from, to), { intervalMs: 5 * MINUTE });
  const tasks = useResource(`tasks:${owner}`, () => agentTasks.list(owner), { intervalMs: 2 * MINUTE });
  const assets = useResource("assets", async () => {
    const r = await loadAssets();
    return { status: r.source === "none" ? 503 : 200, data: r.assets };
  });
  // 服务端整份影响：慢（演示钱包约 18 s），后台取，只用来补「当前判断」
  const impacts = useResource(calendar.state === "ok" || calendar.state === "empty" ? `impacts:${owner}:${hours}` : null, () => eventsApi.impacts(owner, hours));

  const assetList = useMemo(() => assets.data ?? [], [assets.data]);
  const open = useMemo(() => (tasks.data ? openTasks(tasks.data.tasks ?? [], locale) : null), [tasks.data, locale]);
  const events = useDeferredValue(calendar.data?.events);

  // 全部日历事件的命中（抽屉可打开范围外的事件链接）；列表只取范围内的
  const allRows = useMemo<EventRowData[]>(() => {
    const byUnderlying = new Map<string, AssetEntry[]>();
    for (const a of assetList) if (a.role === "stock_output") byUnderlying.set(a.underlyingId, [...(byUnderlying.get(a.underlyingId) ?? []), a]);
    const symbolOf = (k: string) => assetList.find((a) => a.assetKey === k)?.displaySymbol ?? (locale === "zh" ? "未登记资产" : "Unregistered asset");
    return (events ?? []).map((ev) => {
      const evAssets = ev.underlyingIds.flatMap((u) => byUnderlying.get(u) ?? []);
      return { ev, assets: evAssets, hits: open ? matchEvent(ev, open, evAssets.map((a) => a.assetKey), symbolOf) : null };
    });
  }, [events, open, assetList, locale]);
  const rows = useMemo(() => allRows.filter((r) => inHorizon(r.ev, nowMs, hours, r.hits ? latestWindowEnd(r.hits) : null)), [allRows, nowMs, hours]);

  const openIds = useMemo(() => new Set((open ?? []).map((t) => t.id)), [open]);
  const closedCount = tasks.data ? (tasks.data.tasks ?? []).length - (open?.length ?? 0) : null;

  return { nowMs, calendar, tasks, assets, impacts, rows, allRows, assetList, openIds, closedCount, allEvents: calendar.data?.events ?? [] };
}

export type EventDesk = ReturnType<typeof useEventDesk>;
