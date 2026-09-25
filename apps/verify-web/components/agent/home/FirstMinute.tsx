"use client";
/**
 * 新用户第一分钟：选资产 → 示例任务 → 相关日历 / 条件 / 模拟计划 → 运行或回放一次 → 最后才连钱包。
 * 模拟不冒充真实账户或当前市场事件：所有远端数据带来源标识；端点未部署显示「尚未就绪」。
 * 上下文样本（crowsnest 联调黄金样本，provenance.mode=sample）只在 /v1/context 不可用时作为**明确标注的样本**展示字段形状。
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { contextProvenance, marketContext, marketEvents, notReady, type TaskCreated } from "@/lib/api-v2";
import { lab, type ReplayView } from "../lab/api";
import { stocksOf, type AssetsLoad } from "@/lib/assets";
import { conditionText } from "@/lib/conditions";
import { fmtLocal } from "@/lib/format";
import { apiError } from "@/lib/errors";
import type { MarketContext, MarketEvent } from "@chaconne/core/verify";
import { Card, Pill } from "@/components/ui";
import { LoadingState, ModeTag, NotReady } from "../shared";
import { TaskForm } from "../tasks/TaskForm";
import { SAMPLES } from "./entries";
import sampleContext from "./sample_context.agent.json";

type Loaded<T> = { kind: "idle" } | { kind: "busy" } | { kind: "nr"; http: number } | { kind: "err"; msg: string } | { kind: "ok"; v: T };
const SAMPLE = sampleContext as unknown as MarketContext;

export function FirstMinute({ assets, onRetryAssets }: { assets: AssetsLoad; onRetryAssets?: () => void }) {
  const { locale, t } = useI18n();
  const zh = locale === "zh";
  const stocks = stocksOf(assets.assets);
  const [asset, setAsset] = useState("");
  const [sampleIdx, setSampleIdx] = useState(0);
  const [events, setEvents] = useState<Loaded<MarketEvent[]>>({ kind: "idle" });
  const [ctx, setCtx] = useState<Loaded<MarketContext>>({ kind: "idle" });
  const [run, setRun] = useState<Loaded<{ created: TaskCreated } | { replay: ReplayView }>>({ kind: "idle" });
  const [showForm, setShowForm] = useState(false);
  const [showSample, setShowSample] = useState(false);
  const chosen = stocks.find((a) => a.assetKey === asset) ?? stocks[0] ?? null;
  const chosenKey = chosen?.assetKey ?? "";
  const chosenUnderlying = chosen?.underlyingId ?? "";
  const sample = SAMPLES[sampleIdx]!;

  useEffect(() => {
    if (!chosenKey) return;
    let alive = true;
    setEvents({ kind: "busy" });
    setCtx({ kind: "busy" });
    marketEvents.list({ underlyingId: chosenUnderlying }).then((r) => alive && setEvents(r.status === 200 ? { kind: "ok", v: r.data.events } : { kind: "nr", http: r.status })).catch(() => alive && setEvents({ kind: "nr", http: 0 }));
    marketContext.get({ assetKey: chosenKey }).then((r) => alive && setCtx(r.status === 200 ? { kind: "ok", v: r.data } : { kind: "nr", http: r.status })).catch(() => alive && setCtx({ kind: "nr", http: 0 }));
    return () => { alive = false; };
  }, [chosenKey, chosenUnderlying]);

  async function replay() {
    if (!chosen) return;
    setRun({ kind: "busy" });
    // 服务端拒绝 to 在未来：浏览器时钟可能比服务器快，结束点往前留 5 分钟
    const to = new Date(Date.now() - 5 * 60_000);
    const from = new Date(to.getTime() - 3 * 86_400_000);
    // 响应形状是 { replayId, run: { points, coverage, gaps? }, … }（此前按顶层 points 读，整页崩溃）
    const r = await lab.replay({ playbookId: sample.playbookId, conditions: { items: sample.conditions }, assetKey: chosen.assetKey, from: from.toISOString(), to: to.toISOString(), stepMinutes: 60, locale }).catch(() => null);
    if (!r) return setRun({ kind: "nr", http: 0 });
    if (r.status === 201 || r.status === 200) return setRun({ kind: "ok", v: { replay: r.data } });
    if (r.status === 400) return setRun({ kind: "err", msg: apiError(r, locale) });
    setRun({ kind: "nr", http: r.status });
  }
  const ctxView = ctx.kind === "ok" ? ctx.v : showSample ? SAMPLE : null;
  const prov = contextProvenance(ctxView);
  const relEvents = events.kind === "ok" ? events.v.filter((e) => sample.eventKinds.length === 0 || sample.eventKinds.includes(e.kind) || e.underlyingIds.includes(chosen?.underlyingId ?? "")) : [];

  return (
    <Card title={zh ? "第一分钟" : "Your first minute"} right={null}>
      <ol className="ag-steps">
        <li className="ag-step" data-done={chosen ? "1" : "0"}>
          <h3>{zh ? "选一个已支持的资产" : "Pick a supported asset"}</h3>
          {assets.source !== "live" && <p className="ag-warn">{assets.source === "cache" ? t("ag_registry_cached") : t("ag_registry_none")}{onRetryAssets && <> · <button type="button" className="underline" onClick={onRetryAssets}>{t("ag_retry")}</button></>}</p>}
          {stocks.length === 0 ? (assets.source === "live" && <p>{zh ? "登记表里没有可执行的股票资产。" : "No executable stock asset in the registry."}</p>) : <select className="field mt-2 max-w-xs" value={chosen?.assetKey ?? ""} onChange={(e) => setAsset(e.target.value)}>{stocks.map((a) => <option key={a.assetKey} value={a.assetKey}>{a.displaySymbol} · {a.underlyingId.split(":")[1]}</option>)}</select>}
        </li>
        <li className="ag-step" data-done="1">
          <h3>{zh ? "挑一个示例任务" : "Pick a sample task"}</h3>
          <div className="ag-actions mt-2">{SAMPLES.map((s, i) => <button key={s.id} className={`btn-ghost h-8 px-3 text-xs ${i === sampleIdx ? "ring-line-brand text-brand-300" : ""}`} aria-pressed={i === sampleIdx} onClick={() => { setSampleIdx(i); setRun({ kind: "idle" }); }}>{s.title[locale]}</button>)}</div>
          <p className="mt-2">{sample.what[locale]}</p>
        </li>
        <li className="ag-step" data-done={events.kind === "ok" || ctx.kind === "ok" ? "1" : "0"}>
          <h3>{zh ? "看相关日历、条件与上下文" : "See the related calendar, conditions and context"}</h3>
          <div className="ag-grid-2 mt-2">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-fg-3">{zh ? "日历" : "Calendar"}</p>
              {!chosen && <p>{zh ? "先选一个资产（登记表不可达时无法列出）。" : "Pick an asset first (none listed while the registry is unreachable)."}</p>}
              {events.kind === "busy" && <LoadingState />}
              {events.kind === "nr" && (notReady({ status: events.http, data: null }) ? <NotReady what="GET /v1/events" status={events.http} /> : <p>HTTP {events.http}</p>)}
              {events.kind === "ok" && (relEvents.length === 0 ? <p>{zh ? "没有与这个模板相关的排期事件。" : "No scheduled event relevant to this playbook."}</p> : <ul className="ag-list">{relEvents.slice(0, 5).map((e) => <li key={e.id}><span className="text-sm">{e.name}</span> <span className="mono text-[11px] text-fg-3">{e.dateLocal} · {e.kind}</span> <Pill tone={e.status === "confirmed" ? "ok" : "warn"}>{e.status}</Pill> {e.datePrecision !== "exact" && <Pill tone="neutral">{zh ? `精度 ${e.datePrecision}` : `${e.datePrecision} precision`}</Pill>}</li>)}</ul>)}
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-fg-3">{zh ? "条件" : "Conditions"}</p>
              <ul className="ag-list">{sample.conditions.map((c, i) => <li key={i} className="text-xs">{conditionText(c, locale)}</li>)}</ul>
            </div>
          </div>
          <div className="mt-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-fg-3">{zh ? "上下文" : "Context"} {ctxView && <ModeTag mode={prov} />}</p>
            {ctx.kind === "busy" && <LoadingState />}
            {ctx.kind === "nr" && !showSample && <div className="space-y-2"><NotReady what="GET /v1/context" status={ctx.http} /><button className="btn-ghost h-8 px-3 text-xs" onClick={() => setShowSample(true)}>{zh ? "看字段形状（联调样本，明确标注，不代表实时市场）" : "Show the field shape (labelled sample, not the live market)"}</button></div>}
            {ctxView && (
              <div className="mt-2">
                {prov !== "live" && <p className="ag-warn">{prov === "sample" ? (zh ? "这是联调样本：数值来自固定桩，不代表实时市场，不能用于任何 LIVE 判定。" : "This is a sample: values are stubs, not the live market; never used for a LIVE decision.") : prov === "backfill" ? (zh ? "这是回填档案：只能证明过去观测，不是实时。" : "This is a backfill archive: it proves past observations, not the present.") : (zh ? "来源模式未知：不按实时处理。" : "Provenance unknown: not treated as live.")}</p>}
                <dl className="ag-kv mt-2">
                  <dt>session</dt><dd className="mono">{String(ctxView.session?.label?.value ?? "—")} · {ctxView.session?.label?.status}</dd>
                  <dt>usTradingDay</dt><dd className="mono">{String(ctxView.session?.usTradingDay?.value ?? "—")}</dd>
                  <dt>fed.blackout</dt><dd className="mono">{String(ctxView.fed?.blackout?.value ?? "—")} · {ctxView.fed?.blackout?.status}</dd>
                  <dt>rates.y10</dt><dd className="mono">{ctxView.rates?.y10?.value ?? "—"} · {ctxView.rates?.y10?.status}</dd>
                  <dt>risk.vix</dt><dd className="mono">{ctxView.risk?.vix?.value ?? "—"} · {ctxView.risk?.vix?.status}{ctxView.risk?.vix?.note ? ` (${ctxView.risk.vix.note})` : ""}</dd>
                  <dt>packagedAt</dt><dd className="mono">{ctxView.packagedAt}</dd>
                </dl>
              </div>
            )}
          </div>
        </li>
        <li className="ag-step" data-done={run.kind === "ok" ? "1" : "0"}>
          <h3>{zh ? "运行一次模拟，或回放一段" : "Run a simulation, or replay a stretch"}</h3>
          <div className="ag-actions mt-2">
            <button className="btn" disabled={!chosen || run.kind === "busy"} aria-expanded={showForm} onClick={() => setShowForm((v) => !v)}>{zh ? "创建模拟任务" : "Create simulation task"}</button>
            <button className="btn-ghost" disabled={!chosen || run.kind === "busy"} onClick={replay}>{zh ? "回放最近 3 天" : "Replay the last 3 days"}</button>
          </div>
          {showForm && chosen && <div className="mt-3"><TaskForm assets={assets.assets} assetsSource={assets.source} onRetryAssets={onRetryAssets} preset={{ playbookId: sample.playbookId, outputAssetKey: chosen.assetKey, steps: sample.steps, mode: "SIMULATION", conditions: sample.conditions }} modeLock="SIMULATION" onCreated={(v) => { setRun({ kind: "ok", v: { created: v } }); setShowForm(false); }} /></div>}
          {run.kind === "nr" && <NotReady what={"POST /v1/replays"} status={run.http} />}
          {run.kind === "err" && <p className="mt-2 text-sm text-bad" role="alert">{run.msg}</p>}
          {run.kind === "ok" && "created" in run.v && <FirstMinuteTaskResult value={run.v.created} />}
          {run.kind === "ok" && "replay" in run.v && (() => { const pts = run.v.replay.run?.points ?? []; const gaps = run.v.replay.run?.gaps ?? []; const waiting = pts.filter((p) => p.outcome !== "SATISFIED").length; return <div className="mt-2 space-y-1"><div className="ag-actions"><ModeTag mode="REPLAY" /><Link className="text-sm underline" href="/agent/lab#replay">{zh ? "去实验页做完整回放 →" : "Full replay on the lab page →"}</Link></div><p className="ag-note">{zh ? `最近 3 天每小时评估一次：${pts.length} 个评估点，其中 ${pts.length - waiting} 个满足条件、${waiting} 个在等待；${gaps.length} 段缺口如实显示。只用当时可知的信息，不输出收益。` : `Hourly over the last 3 days: ${pts.length} evaluation points, ${pts.length - waiting} satisfied and ${waiting} waiting; ${gaps.length} gap(s) shown as gaps. Only information known at the time, no returns.`}</p></div>; })()}
        </li>
      </ol>
    </Card>
  );
}

/** 结果的模式只来自响应，不能用入口所选模式替代服务端缺失信息。 */
export function FirstMinuteTaskResult({ value }: { value: TaskCreated }) {
  const { locale, t } = useI18n();
  const zh = locale === "zh";
  const { task } = value;
  return <div className="mt-2 space-y-1">
    <div className="ag-actions"><ModeTag mode={value.mode ?? "unknown"} /><Pill tone="ok">{t("ag_task_created")}</Pill><Link className="text-sm underline" href={`/agent/tasks/${task.id}`}>{zh ? "打开任务 →" : "Open the task →"}</Link></div>
    <p className="ag-note">{zh ? `阻塞项 ${task.blockers.length} 个；下次检查 ${task.nextCheckAt ? fmtLocal(task.nextCheckAt, locale) : "未知"}。` : `${task.blockers.length} blocker(s); next check ${task.nextCheckAt ? fmtLocal(task.nextCheckAt, locale) : "unknown"}.`}</p>
    <p className="ag-note">{value.mode === "SIMULATION" ? (zh ? "这是条件模拟，不签发交易证书，也不会执行买入。打开任务可查看等待原因。" : "This simulates the conditions. No trade certificate is signed and no buy is executed. Open the task to see why it is waiting.") : value.mode === "LIVE" ? (zh ? "服务返回的是实盘任务。创建成功不代表已经授权或成交，请打开任务确认下一步。" : "The service returned a live task. Creation does not mean authorization or execution; open the task to review its next step.") : (zh ? "服务未返回任务模式。请打开任务核对，不能据此认定为模拟或实盘。" : "The service did not return a task mode. Open the task to check; this response does not establish simulation or live mode.")}</p>
  </div>;
}
