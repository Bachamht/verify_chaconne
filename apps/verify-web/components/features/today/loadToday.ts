"use client";
/**
 * 「今天」的装载分三批，按优先级先后发出（手机上并发连接少，别让活动流挡住事件）：
 *  1. 事件（/v1/event-impacts）：页面最先发起；
 *  2. 任务板（列表 + 记录 + 资产，内部 Promise.all）：loadToday；
 *  3. 活动流：事件请求结束、任务板到手后，才为最近更新的 PULSE_CAP 个未结束任务各拉 PULSE_LIMIT 条（loadPulses）。
 * 「Agent 刚说」「今日成交」都只用第 3 批的结果；拿不到就写「—」。
 */
import { v7 } from "@/lib/api-v2";
import type { ApiResult } from "@/lib/useResource";
import { loadTaskBoard, type TaskBoard } from "../tasks/loadBoard";
import { PULSE_LIMIT, type Pulse } from "./model";

export interface TodayData { board: TaskBoard; at: string }
export interface PulseData { pulses: Pulse[]; coversToday: boolean }

export async function loadToday(owner: string): Promise<ApiResult<TodayData>> {
  const b = await loadTaskBoard(owner);
  if (b.status !== 200) return { status: b.status, data: b.data as unknown as TodayData };
  return { status: 200, data: { board: b.data, at: new Date().toISOString() } };
}

/** 选好的任务并行拉活动流（含 runtime.needsOwner）；单个失败只标 ok=false，不拖累整批 */
export async function loadPulses(ids: readonly string[], coversToday: boolean): Promise<ApiResult<PulseData>> {
  const pulses = await Promise.all(ids.map(async (taskId): Promise<Pulse> => {
    const r = await v7.activity(taskId, null, PULSE_LIMIT).catch(() => null);
    if (!r || r.status !== 200) return { taskId, ok: false, items: [], needs: null };
    const needs = r.data.runtime && Array.isArray(r.data.runtime.needsOwner) ? r.data.runtime.needsOwner : null;
    return { taskId, ok: true, items: r.data.items, needs };
  }));
  return { status: 200, data: { pulses, coversToday } };
}
