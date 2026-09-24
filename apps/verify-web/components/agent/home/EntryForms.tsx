"use client";
/** 四入口的引导表单：每个都直接打对应端点；端点未部署 → NotReady 空态。 */
import Link from "next/link";
import { useState } from "react";
import { useI18n } from "@/lib/i18n";
import { marketEvents, notReady } from "@/lib/api-v2";
import { apiError } from "@/lib/errors";
import type { EventImpact } from "@chaconne/core/verify";
import type { AssetEntry } from "@/lib/assets";
import { Pill } from "@/components/ui";
import { NotReady, OwnerField, shortKey, useOwnerInput } from "../shared";
import { TaskForm } from "../tasks/TaskForm";
import type { TaskDraft } from "../tasks/taskDraft";
import type { EntryId } from "./entries";

export function ImpactForm() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const { owner, setOwner, connected, valid } = useOwnerInput();
  const [state, setState] = useState<{ kind: "idle" } | { kind: "busy" } | { kind: "nr"; http: number } | { kind: "err"; msg: string } | { kind: "ok"; items: EventImpact[] }>({ kind: "idle" });
  async function run() {
    setState({ kind: "busy" });
    const r = await marketEvents.impacts(owner.toLowerCase(), 48).catch(() => null);
    if (!r) return setState({ kind: "err", msg: zh ? "服务不可达" : "Service unreachable" });
    if (notReady(r)) return setState({ kind: "nr", http: r.status });
    if (r.status !== 200) return setState({ kind: "err", msg: apiError(r, locale) });
    setState({ kind: "ok", items: r.data.impacts });
  }
  return (
    <div className="space-y-3">
      <div className="ag-form"><OwnerField owner={owner} setOwner={setOwner} connected={connected} /></div>
      <div className="ag-actions"><button className="btn" disabled={!valid || state.kind === "busy"} onClick={run}>{zh ? "查 48 小时内的影响" : "Check the next 48 h"}</button><Link className="btn-ghost" href="/agent/events">{zh ? "去事件台" : "Open the event desk"}</Link></div>
      {state.kind === "nr" && <NotReady what="GET /v1/event-impacts" status={state.http} />}
      {state.kind === "err" && <p className="text-sm text-bad">{state.msg}</p>}
      {state.kind === "ok" && (state.items.length === 0 ? <p className="ag-note">{zh ? "48 小时内没有与你持仓或任务相关的排期事件。未覆盖的资产不在此列（显示为未知，不是没有影响）。" : "No scheduled event touches your holdings or tasks in 48 h. Uncovered assets are not listed (unknown, not 'no impact')."}</p> : (
        <ul className="ag-list">{state.items.map((i) => <li key={i.eventId}><div className="ag-actions"><span className="mono text-xs">{i.eventId}</span><Pill tone={i.relation === "company_direct" ? "warn" : i.relation === "user_rule" ? "info" : "neutral"}>{i.relation}</Pill></div><p className="ag-note">{zh ? "资产" : "assets"}: {i.assets.map(shortKey).join(", ") || "—"} · {zh ? "任务" : "tasks"}: {i.tasks.map((t) => `${t.taskId}:${t.effect}`).join(", ") || "—"} · {zh ? "可选动作" : "actions"}: {i.actions.join(" / ")}</p>{i.relation === "macro_research" && <p className="ag-note">{zh ? "宏观事件只标研究关联，不写涨跌。" : "Macro events are research links only; no direction is implied."}</p>}</li>)}</ul>
      ))}
    </div>
  );
}

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
  if (entry === "buy") return <TaskForm assets={assets} assetsSource={assetsSource} onRetryAssets={onRetryAssets} preset={preset} />;
  if (entry === "impact") return <ImpactForm />;
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
