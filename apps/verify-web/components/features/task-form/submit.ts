"use client";
/** 建任务（/start 与 /agent/new 共用）：fixture 不发请求；其余 POST /v1/tasks 后按 classifyCreate 分类。请求体与幂等编号由调用方保管 */
import { agentTasks } from "@/lib/api-v2";
import type { Locale } from "@/lib/i18n";
import type { V7CreateBody } from "@/components/onboarding/modelV7";
import { classifyCreate, type CreateOutcome } from "./model";

export const FIXTURE_TASK_ID = "tsk_fixture";

export async function submitTask(body: V7CreateBody, opts: { mode: "SIMULATION" | "LIVE"; owner: string; fixture: boolean; locale: Locale }): Promise<CreateOutcome> {
  if (opts.fixture) return { kind: "ok", id: FIXTURE_TASK_ID };
  const r = await agentTasks.create(body).catch(() => null);
  return classifyCreate(r, { mode: opts.mode, owner: opts.owner }, opts.locale);
}

/** 控制台链接（fixture 保留 ?v7fixture=1） */
export function taskConsoleHref(id: string, fixture: boolean): string {
  return `/agent/tasks/${encodeURIComponent(id)}${fixture ? "?v7fixture=1" : ""}`;
}
