"use client";
/**
 * 任务数据的一次装载（任务列表与「今天」共用）：
 *  第一波 Promise.all：任务列表 + 全部记录 + 资产登记表；
 *  第二波：records 独有的任务（Agent 接入 key 建的）逐个取详情补齐，最多 MAX_EXTRA 个，并行。
 * 两路都失败才算失败；只失败一路时 partial 标出来，页面写明「可能不全」。
 */
import type { Task } from "@chaconne/core/verify";
import { agentTasks, records as recordsApi, type RecordItem } from "@/lib/api-v2";
import { loadAssets, type AssetEntry } from "@/lib/assets";
import type { ApiResult } from "@/lib/useResource";
import { recordOnlyTaskIds, type TaskMode } from "./model";

const MAX_EXTRA = 12;

export interface TaskBoard {
  listed: Task[];
  records: RecordItem[] | null;
  details: Record<string, { task: Task; mode?: TaskMode | null; params?: Record<string, unknown> }>;
  assets: AssetEntry[];
  /** 哪一路没拿到：list = /v1/tasks；records = /v1/records */
  partial: "list" | "records" | null;
}

export async function loadTaskBoard(owner: string): Promise<ApiResult<TaskBoard>> {
  const who = owner.toLowerCase();
  const [list, recs, assets] = await Promise.all([
    agentTasks.list(who).catch(() => ({ status: 0, data: null })),
    recordsApi.list(who).catch(() => ({ status: 0, data: null })),
    loadAssets().catch(() => ({ assets: [], source: "none" as const, evidenceMode: null })),
  ]);
  const listOk = list.status === 200 && !!list.data;
  const recOk = recs.status === 200 && !!recs.data;
  if (!listOk && !recOk) return { status: list.status || recs.status, data: (list.data ?? recs.data) as unknown as TaskBoard };
  const listed = listOk ? (list.data as { tasks: Task[] }).tasks : [];
  const records = recOk ? (recs.data as { items: RecordItem[] }).items : null;
  const extra = recordOnlyTaskIds(listed, records).slice(0, MAX_EXTRA);
  const got = await Promise.all(extra.map((id) => agentTasks.get(id, who).catch(() => null)));
  const details: TaskBoard["details"] = {};
  got.forEach((r, i) => {
    if (r && r.status === 200 && r.data?.task) details[extra[i]!] = { task: r.data.task, mode: r.data.mode ?? null, params: r.data.params };
  });
  return { status: 200, data: { listed, records, details, assets: assets.assets, partial: !listOk ? "list" : !recOk ? "records" : null } };
}
