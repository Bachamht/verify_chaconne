"use client";
/** 四入口的引导表单：每个都直接打对应端点；端点未部署 → NotReady 空态。 */
import Link from "next/link";
import { useState } from "react";
import { useI18n } from "@/lib/i18n";
import type { AssetEntry } from "@/lib/assets";
import { GoalTaskForm } from "../tasks/GoalTaskForm";
import { TaskForm } from "../tasks/TaskForm";
import type { TaskDraft } from "../tasks/taskDraft";
import type { EntryId } from "./entries";

/** 「诊断等待」只保留 /agent/lab 一套实现（V-33）：这里只是入口 */
export function labWaitHref(taskId?: string | null): string {
  return `/agent/lab${taskId ? `?taskId=${encodeURIComponent(taskId)}` : ""}#wait`;
}
export function WaitEntry({ taskId }: { taskId?: string }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const [id, setId] = useState(taskId ?? "");
  return (
    <div className="space-y-3">
      <p className="ag-note">{zh ? "列出任务的全部阻塞项、每项的证据时间与已知的下次检查点。诊断在实验页完成，任务 id 会带上。" : "Every blocker on the task, each with its evidence time and known next check. The diagnosis runs on the lab page; the task id carries over."}</p>
      <div className="ag-form"><label className="ag-span">{zh ? "任务 id" : "Task id"}<input className="field mono" value={id} onChange={(e) => setId(e.target.value)} placeholder="tsk_…" /></label></div>
      <div className="ag-actions"><Link className="btn" href={labWaitHref(id.trim() || null)} aria-disabled={!id.trim()}>{zh ? "去实验页诊断 →" : "Diagnose on the lab page →"}</Link></div>
    </div>
  );
}

export function EntryPanel({ entry, assets, assetsSource, onRetryAssets, preset, taskId }: { entry: EntryId; assets: AssetEntry[]; assetsSource?: "live" | "cache" | "none"; onRetryAssets?: () => void; preset?: Partial<TaskDraft>; taskId?: string }) {
  if (entry === "goal") return <GoalTaskForm assets={assets} assetsSource={assetsSource} onRetryAssets={onRetryAssets} />;
  if (entry === "buy") return <TaskForm assets={assets} assetsSource={assetsSource} onRetryAssets={onRetryAssets} preset={preset} />;
  if (entry === "wait") return <WaitEntry taskId={taskId} />;
  return <CompareEntry taskId={taskId} />;
}

/** 「比较两个方案」只保留 /agent/lab 一套实现（V-26）：这里只是入口，不再内嵌渲染 */
export function labCompareHref(taskId?: string | null, asset?: string | null): string {
  const q = new URLSearchParams();
  if (taskId) q.set("taskId", taskId);
  if (asset) q.set("asset", asset);
  const qs = q.toString();
  return `/agent/lab${qs ? `?${qs}` : ""}#compare`;
}
export function CompareEntry({ taskId }: { taskId?: string }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const [id, setId] = useState(taskId ?? "");
  return (
    <div className="space-y-3">
      <p className="ag-note">{zh ? "两套条件、同一份证据快照、不执行。对照在实验页完成：输入任务 id 后跳过去，任务 id 会带上。" : "Two condition sets, one evidence snapshot, no execution. The comparison runs on the lab page; the task id carries over."}</p>
      <div className="ag-form"><label className="ag-span">{zh ? "任务 id（可选）" : "Task id (optional)"}<input className="field mono" value={id} onChange={(e) => setId(e.target.value)} placeholder="tsk_…" /></label></div>
      <div className="ag-actions"><Link className="btn" href={labCompareHref(id.trim() || null)}>{zh ? "去实验页对照 →" : "Open the lab comparison →"}</Link></div>
    </div>
  );
}
