/** 「最近一个事件」的口径（V-30）：只取未来、未取消的事件里最早的一个；过去的或已取消的不算。纯函数，页面与测试共用。 */
import type { MarketEvent } from "@chaconne/core/verify";

export function eventTimeMs(e: Pick<MarketEvent, "scheduledAtUtc" | "dateLocal">): number {
  if (e.scheduledAtUtc) {
    const t = Date.parse(e.scheduledAtUtc);
    if (!Number.isNaN(t)) return t;
  }
  // 只有日期：按当地日期的末尾算「未来」，当天的事件仍算未来
  const t = Date.parse(`${e.dateLocal}T23:59:59Z`);
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

export function nextUpcomingEvent<T extends Pick<MarketEvent, "scheduledAtUtc" | "dateLocal" | "status">>(events: readonly T[], nowMs: number): T | null {
  let best: T | null = null;
  let bestT = Number.POSITIVE_INFINITY;
  for (const e of events) {
    if (e.status === "cancelled" || e.status === "released") continue;
    const t = eventTimeMs(e);
    if (t < nowMs) continue;
    if (t < bestT) { best = e; bestT = t; }
  }
  return best;
}
