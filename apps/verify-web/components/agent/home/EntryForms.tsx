"use client";
/** 四入口的引导表单：每个都直接打对应端点；端点未部署 → NotReady 空态。 */
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useI18n } from "@/lib/i18n";
import { api, type AssetsResponse } from "@/lib/api";
import { agentTasks, marketEvents, notReady, type CreateTaskBody, type ExplainWaitView } from "@/lib/api-v2";
import { apiError } from "@/lib/errors";
import { remember } from "@/lib/history";
import type { EventImpact, PolicyComparison } from "@chaconne/core/verify";
import { Card, Pill } from "@/components/ui";
import { ModeTag, NotReady, OwnerField, shortKey, useOwnerInput } from "../shared";
import { COMPARE_PRESETS, SAMPLES, type EntryId } from "./entries";

type Assets = AssetsResponse["assets"];

export function BuyForm({ assets, presetPlaybook, presetAsset }: { assets: Assets; presetPlaybook?: string; presetAsset?: string }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const router = useRouter();
  const { owner, setOwner, connected, valid } = useOwnerInput();
  const stocks = assets.filter((a) => a.role === "stock_output" && a.executionAllowed);
  const [asset, setAsset] = useState(presetAsset ?? "");
  const [playbook, setPlaybook] = useState(presetPlaybook && SAMPLES.some((s) => s.playbookId === presetPlaybook) ? presetPlaybook : SAMPLES[0]!.playbookId);
  const [steps, setSteps] = useState("3");
  const [mode, setMode] = useState<"SIMULATION" | "LIVE">("SIMULATION");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [nr, setNr] = useState<number | null>(null);
  const sample = SAMPLES.find((s) => s.playbookId === playbook)!;
  const chosen = asset || stocks[0]?.assetKey || "";
  async function submit() {
    if (!valid || !chosen) return;
    setBusy(true);
    setMsg(null);
    const body: CreateTaskBody = { clientRequestId: `web-${Date.now()}`, ownerAddress: owner.toLowerCase(), playbookId: sample.playbookId, params: { ...sample.params(chosen), steps: Number(steps) || 3 }, conditions: { version: "conditions/1", items: sample.conditions }, mode };
    const r = await agentTasks.create(body).catch(() => null);
    setBusy(false);
    if (!r) return setMsg(zh ? "服务不可达" : "Service unreachable");
    if (notReady(r)) return setNr(r.status);
    if (r.status !== 201) return setMsg(apiError(r, locale));
    remember({ kind: "mandate", id: r.data.task.id, title: `${sample.playbookId} ${shortKey(chosen)} (${mode})`, owner: owner.toLowerCase() });
    router.push(`/agent/tasks/${r.data.task.id}`);
  }
  if (nr !== null) return <NotReady what="POST /v1/tasks" status={nr} />;
  return (
    <div className="space-y-3">
      <div className="ag-form">
        <label>{zh ? "资产" : "Asset"}<select className="field" value={chosen} onChange={(e) => setAsset(e.target.value)}>{stocks.map((a) => <option key={a.assetKey} value={a.assetKey}>{a.displaySymbol} · {a.underlyingId.split(":")[1]}</option>)}</select></label>
        <label>{zh ? "模板" : "Playbook"}<select className="field" value={playbook} onChange={(e) => setPlaybook(e.target.value)}>{SAMPLES.map((s) => <option key={s.playbookId} value={s.playbookId}>{s.title[locale]}</option>)}</select></label>
        <label>{zh ? "步数" : "Steps"}<input className="field" inputMode="numeric" value={steps} onChange={(e) => setSteps(e.target.value)} /></label>
        <label>{zh ? "模式" : "Mode"}<select className="field" value={mode} onChange={(e) => setMode(e.target.value as "SIMULATION" | "LIVE")}><option value="SIMULATION">{zh ? "模拟（不签名不花钱）" : "Simulation (no signature, no money)"}</option><option value="LIVE">{zh ? "真实（之后签署授权）" : "Live (sign an authorization next)"}</option></select></label>
        <OwnerField owner={owner} setOwner={setOwner} connected={connected} />
      </div>
      <p className="ag-note">{sample.what[locale]}</p>
      <ul className="ag-list text-xs">{sample.conditions.map((c, i) => <li key={i} className="mono">{JSON.stringify(c)}</li>)}</ul>
      <div className="ag-actions">
        <button className="btn" disabled={busy || !valid || !chosen} onClick={submit}>{busy ? (zh ? "创建中…" : "Creating…") : mode === "SIMULATION" ? (zh ? "创建模拟任务" : "Create simulation task") : (zh ? "创建任务（下一步签授权）" : "Create task (authorize next)")}</button>
        <ModeTag mode={mode} />
        {!valid && <span className="ag-note">{zh ? "填一个钱包地址即可，模拟不需要连接。" : "Any wallet address works; simulation needs no connection."}</span>}
      </div>
      {msg && <p className="text-sm text-bad">{msg}</p>}
    </div>
  );
}

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

export function WaitForm({ presetTaskId }: { presetTaskId?: string }) {
  const { locale, t } = useI18n();
  const zh = locale === "zh";
  const [taskId, setTaskId] = useState(presetTaskId ?? "");
  const [state, setState] = useState<{ kind: "idle" } | { kind: "busy" } | { kind: "nr"; http: number } | { kind: "err"; msg: string } | { kind: "ok"; v: ExplainWaitView }>({ kind: "idle" });
  async function run() {
    setState({ kind: "busy" });
    const r = await agentTasks.explainWait(taskId.trim()).catch(() => null);
    if (!r) return setState({ kind: "err", msg: zh ? "服务不可达" : "Service unreachable" });
    if (notReady(r)) return setState({ kind: "nr", http: r.status });
    if (r.status !== 200) return setState({ kind: "err", msg: apiError(r, locale) });
    setState({ kind: "ok", v: r.data });
  }
  return (
    <div className="space-y-3">
      <div className="ag-form"><label className="ag-span">{zh ? "任务 id" : "Task id"}<input className="field mono" value={taskId} onChange={(e) => setTaskId(e.target.value)} placeholder="tsk_…" /></label></div>
      <div className="ag-actions"><button className="btn" disabled={!taskId.trim() || state.kind === "busy"} onClick={run}>{zh ? "解释为什么在等" : "Explain the wait"}</button><Link className="btn-ghost" href="/agent/lab">{zh ? "去实验页" : "Open the lab"}</Link></div>
      {state.kind === "nr" && <NotReady what="GET /v1/tasks/:id/explain-wait" status={state.http} />}
      {state.kind === "err" && <p className="text-sm text-bad">{state.msg}</p>}
      {state.kind === "ok" && <Blockers blockers={state.v.blockers} nextCheckAt={state.v.nextCheckAt} userActionRequired={(state.v.userActionRequired?.length ?? 0) > 0} labelAll={t("ag_blockers")} labelNone={t("ag_no_blockers")} labelNext={t("ag_next_check")} />}
    </div>
  );
}

export function Blockers({ blockers, nextCheckAt, userActionRequired, labelAll, labelNone, labelNext }: { blockers: ExplainWaitView["blockers"]; nextCheckAt: string | null; userActionRequired?: boolean; labelAll: string; labelNone: string; labelNext: string }) {
  const { locale } = useI18n();
  return (
    <div className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wide text-fg-3">{labelAll} · {blockers.length}</p>
      {blockers.length === 0 ? <p className="ag-note">{labelNone}</p> : (
        <ul className="ag-list">{blockers.map((b, i) => <li key={`${b.code}-${i}`}><div className="ag-blocker"><code>{b.code}</code><span>{b.text}{b.userActionRequired && <Pill tone="warn">{locale === "zh" ? "需要你决定" : "needs you"}</Pill>}</span><span className="mono text-[11px] text-fg-3">{locale === "zh" ? "证据时间" : "evidence"}</span><span className="mono text-[11px] text-fg-3">{b.evidenceAt ?? "—"}</span></div></li>)}</ul>
      )}
      <p className="ag-note">{labelNext}: <span className="mono">{nextCheckAt ?? (locale === "zh" ? "未知（如现金下限）" : "unknown (e.g. cash floor)")}</span>{userActionRequired ? ` · ${locale === "zh" ? "有需要你决定的项" : "some items need your decision"}` : ""}</p>
    </div>
  );
}

export function CompareForm({ presetTaskId }: { presetTaskId?: string }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const [taskId, setTaskId] = useState(presetTaskId ?? "");
  const [preset, setPreset] = useState(COMPARE_PRESETS[0]!.id);
  const [state, setState] = useState<{ kind: "idle" } | { kind: "busy" } | { kind: "nr"; http: number } | { kind: "err"; msg: string } | { kind: "ok"; v: PolicyComparison }>({ kind: "idle" });
  const p = COMPARE_PRESETS.find((x) => x.id === preset)!;
  async function run() {
    setState({ kind: "busy" });
    const r = await agentTasks.comparePolicies(taskId.trim(), p.variants.map((v) => ({ label: v.label, conditions: { version: "conditions/1", items: v.items } }))).catch(() => null);
    if (!r) return setState({ kind: "err", msg: zh ? "服务不可达" : "Service unreachable" });
    if (notReady(r)) return setState({ kind: "nr", http: r.status });
    if (r.status !== 201 && r.status !== 200) return setState({ kind: "err", msg: apiError(r, locale) });
    setState({ kind: "ok", v: r.data });
  }
  return (
    <div className="space-y-3">
      <div className="ag-form">
        <label>{zh ? "任务 id" : "Task id"}<input className="field mono" value={taskId} onChange={(e) => setTaskId(e.target.value)} placeholder="tsk_…" /></label>
        <label>{zh ? "对照" : "Comparison"}<select className="field" value={preset} onChange={(e) => setPreset(e.target.value)}>{COMPARE_PRESETS.map((c) => <option key={c.id} value={c.id}>{c.title[locale]}</option>)}</select></label>
      </div>
      <p className="ag-note">{zh ? "同一份证据快照、同资产与费用假设；结果标 SIMULATION，不改真实任务，不写任何授权，不输出收益。" : "Same evidence snapshot, same asset and fee assumptions; labelled SIMULATION, never touches the real task, writes no authorization, outputs no returns."}</p>
      <div className="ag-actions"><button className="btn" disabled={!taskId.trim() || state.kind === "busy"} onClick={run}>{zh ? "对照" : "Compare"}</button><Link className="btn-ghost" href="/agent/lab">{zh ? "去实验页" : "Open the lab"}</Link></div>
      {state.kind === "nr" && <NotReady what="POST /v1/tasks/:id/compare-policies" status={state.http} />}
      {state.kind === "err" && <p className="text-sm text-bad">{state.msg}</p>}
      {state.kind === "ok" && (
        <div className="space-y-2">
          <div className="ag-actions"><ModeTag mode={state.v.mode} /><span className="mono text-xs text-fg-3">snapshot {state.v.evidenceSnapshotId}</span></div>
          <div className="ag-grid-2">{state.v.variants.map((v) => <Card key={v.label} title={v.label}><p className="mono text-sm">{v.outcome}</p><ul className="ag-list text-xs">{v.perItem.map((it, i) => <li key={i}><code className="mono">{it.item.type}</code> → {it.outcome}{it.reasons.length ? ` (${it.reasons.map((r) => r.code).join(", ")})` : ""}</li>)}</ul></Card>)}</div>
        </div>
      )}
    </div>
  );
}

export function EntryPanel({ entry, assets, preset }: { entry: EntryId; assets: Assets; preset: { playbook?: string; asset?: string; taskId?: string } }) {
  if (entry === "buy") return <BuyForm assets={assets} presetPlaybook={preset.playbook} presetAsset={preset.asset} />;
  if (entry === "impact") return <ImpactForm />;
  if (entry === "wait") return <WaitForm presetTaskId={preset.taskId} />;
  return <CompareForm presetTaskId={preset.taskId} />;
}

export async function loadAssets(): Promise<Assets> {
  try {
    const r = await api<AssetsResponse>("GET", "v1/assets");
    return r.status === 200 && Array.isArray(r.data.assets) ? r.data.assets : [];
  } catch {
    return [];
  }
}
