"use client";
/**
 * 事件台 v8 的取数。拆成三段，先快后慢：
 *  1. GET /v1/events（日历，约 0.2 s）→ 立刻出事件列表
 *  2. GET /v1/tasks（任务，约 0.4 s）→ 浏览器里只为未结束任务算命中与人话
 *  3. GET /v1/event-impacts（服务端整份影响清单，演示钱包约 18 s）→ 后台补上服务端当前判断（阻塞原因），不挡首屏
 * 动作仍走旧事件台的 POST /v1/event-impacts/actions（components/agent/events/api.ts）。
 */
import type { MarketEvent } from "@chaconne/core/verify";
import { api } from "@/lib/api";
import type { ImpactsResponse } from "@/components/agent/events/api";

export interface CoverageRow { underlyingId: string; state: "covered" | "unknown" | "unavailable" | "not_probed"; lastProbedAt: string | null; eventIds: string[] }
export interface CoverageResponse { source: string; coverage: CoverageRow[]; corporateActions?: { status: string } }

/** 服务端影响清单可能比 30 s 慢（任务多时），给到 60 s；它只补充说明，超时也不影响列表 */
const IMPACTS_TIMEOUT_MS = 60_000;

export const eventsApi = {
  calendar: (from: string, to: string) => api<{ events: MarketEvent[] }>("GET", `v1/events?from=${from}&to=${to}`),
  coverage: () => api<CoverageResponse>("GET", "v1/events/earnings/coverage"),
  impacts: (owner: string, hours: number) => api<ImpactsResponse>("GET", `v1/event-impacts?owner=${encodeURIComponent(owner)}&horizonHours=${hours}`, undefined, {}, { timeoutMs: IMPACTS_TIMEOUT_MS }),
};
