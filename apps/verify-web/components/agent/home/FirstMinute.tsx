"use client";
/**
 * 新用户第一分钟：选资产 → 示例任务 → 相关日历 / 条件 / 模拟计划 → 运行或回放一次 → 最后才连钱包。
 * 模拟不冒充真实账户或当前市场事件：所有远端数据带来源标识；端点未部署显示「尚未就绪」。
 * 上下文样本（crowsnest 联调黄金样本，provenance.mode=sample）只在 /v1/context 不可用时作为**明确标注的样本**展示字段形状。
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import type { AssetsResponse } from "@/lib/api";
import { agentTasks, contextProvenance, marketContext, marketEvents, notReady, replays } from "@/lib/api-v2";
import { connect } from "@/lib/wallet";
import { useAccount } from "@/lib/useAccount";
import type { MarketContext, MarketEvent, ReplayRun, Task } from "@chaconne/core/verify";
import { Card, Pill } from "@/components/ui";
import { ModeTag, NotReady, shortKey } from "../shared";
import { SAMPLES } from "./entries";
import sampleContext from "./sample_context.agent.json";

type Assets = AssetsResponse["assets"];
type Loaded<T> = { kind: "idle" } | { kind: "busy" } | { kind: "nr"; http: number } | { kind: "ok"; v: T };
const SAMPLE = sampleContext as unknown as MarketContext;

export function FirstMinute({ assets }: { assets: Assets }) {
  const { locale, t } = useI18n();
  const zh = locale === "zh";
  const account = useAccount();
  const stocks = assets.filter((a) => a.role === "stock_output" && a.executionAllowed);
  const [asset, setAsset] = useState("");
  const [sampleIdx, setSampleIdx] = useState(0);
  const [events, setEvents] = useState<Loaded<MarketEvent[]>>({ kind: "idle" });
  const [ctx, setCtx] = useState<Loaded<MarketContext>>({ kind: "idle" });
  const [run, setRun] = useState<Loaded<{ task: Task } | { replay: ReplayRun }>>({ kind: "idle" });
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

  async function simulate() {
    if (!chosen) return;
    setRun({ kind: "busy" });
    const owner = account ?? "0x0000000000000000000000000000000000000001"; // 模拟不需要真实账户：占位 owner 只用于 SIMULATION，页面明示
    const r = await agentTasks.create({ clientRequestId: `fm-${Date.now()}`, ownerAddress: owner, playbookId: sample.playbookId, params: sample.params(chosen.assetKey), conditions: { version: "conditions/1", items: sample.conditions }, mode: "SIMULATION" }).catch(() => null);
    if (!r) return setRun({ kind: "nr", http: 0 });
    if (r.status === 201) return setRun({ kind: "ok", v: { task: r.data.task } });
    setRun({ kind: "nr", http: r.status });
  }
  async function replay() {
    if (!chosen) return;
    setRun({ kind: "busy" });
    const to = new Date();
    const from = new Date(to.getTime() - 3 * 86_400_000);
    const r = await replays.create({ playbookId: sample.playbookId, conditions: { version: "conditions/1", items: sample.conditions }, assetKey: chosen.assetKey, from: from.toISOString(), to: to.toISOString() }).catch(() => null);
    if (!r) return setRun({ kind: "nr", http: 0 });
    if (r.status === 201 || r.status === 200) return setRun({ kind: "ok", v: { replay: r.data } });
    setRun({ kind: "nr", http: r.status });
  }
  const ctxView = ctx.kind === "ok" ? ctx.v : showSample ? SAMPLE : null;
  const prov = contextProvenance(ctxView);
  const relEvents = events.kind === "ok" ? events.v.filter((e) => sample.eventKinds.length === 0 || sample.eventKinds.includes(e.kind) || e.underlyingIds.includes(chosen?.underlyingId ?? "")) : [];

  return (
    <Card title={zh ? "第一分钟" : "Your first minute"} right={<Pill tone="brand">{zh ? "不需要钱包" : "no wallet needed"}</Pill>}>
      <ol className="ag-steps">
        <li className="ag-step" data-done={chosen ? "1" : "0"}>
          <h3>{zh ? "选一个已支持的资产" : "Pick a supported asset"}</h3>
          {stocks.length === 0 ? <p>{zh ? "登记表不可达，无法列出资产。" : "Registry unreachable; cannot list assets."}</p> : <select className="field mt-2 max-w-xs" value={chosen?.assetKey ?? ""} onChange={(e) => setAsset(e.target.value)}>{stocks.map((a) => <option key={a.assetKey} value={a.assetKey}>{a.displaySymbol} · {a.underlyingId.split(":")[1]}</option>)}</select>}
        </li>
        <li className="ag-step" data-done="1">
          <h3>{zh ? "挑一个示例任务" : "Pick a sample task"}</h3>
          <div className="ag-actions mt-2">{SAMPLES.map((s, i) => <button key={s.playbookId} className={`btn-ghost h-8 px-3 text-xs ${i === sampleIdx ? "ring-line-brand text-brand-300" : ""}`} aria-pressed={i === sampleIdx} onClick={() => { setSampleIdx(i); setRun({ kind: "idle" }); }}>{s.title[locale]}</button>)}</div>
          <p className="mt-2">{sample.what[locale]}</p>
        </li>
        <li className="ag-step" data-done={events.kind === "ok" || ctx.kind === "ok" ? "1" : "0"}>
          <h3>{zh ? "看相关日历、条件与上下文" : "See the related calendar, conditions and context"}</h3>
          <div className="ag-grid-2 mt-2">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-fg-3">{zh ? "日历" : "Calendar"}</p>
              {!chosen && <p>{zh ? "先选一个资产（登记表不可达时无法列出）。" : "Pick an asset first (none listed while the registry is unreachable)."}</p>}
              {events.kind === "busy" && <p>{t("ag_loading")}</p>}
              {events.kind === "nr" && (notReady({ status: events.http, data: null }) ? <NotReady what="GET /v1/events" status={events.http} /> : <p>HTTP {events.http}</p>)}
              {events.kind === "ok" && (relEvents.length === 0 ? <p>{zh ? "没有与这个模板相关的排期事件。" : "No scheduled event relevant to this playbook."}</p> : <ul className="ag-list">{relEvents.slice(0, 5).map((e) => <li key={e.id}><span className="text-sm">{e.name}</span> <span className="mono text-[11px] text-fg-3">{e.dateLocal} · {e.kind}</span> <Pill tone={e.status === "confirmed" ? "ok" : "warn"}>{e.status}</Pill> {e.datePrecision !== "exact" && <Pill tone="neutral">{zh ? `精度 ${e.datePrecision}` : `${e.datePrecision} precision`}</Pill>}</li>)}</ul>)}
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-fg-3">{zh ? "条件" : "Conditions"}</p>
              <ul className="ag-list">{sample.conditions.map((c, i) => <li key={i} className="mono text-[11px]">{JSON.stringify(c)}</li>)}</ul>
            </div>
          </div>
          <div className="mt-3">
            <p className="text-xs font-semibold uppercase tracking-wide text-fg-3">{zh ? "上下文" : "Context"} {ctxView && <ModeTag mode={prov} />}</p>
            {ctx.kind === "busy" && <p>{t("ag_loading")}</p>}
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
            <button className="btn" disabled={!chosen || run.kind === "busy"} onClick={simulate}>{zh ? "创建模拟任务" : "Create simulation task"}</button>
            <button className="btn-ghost" disabled={!chosen || run.kind === "busy"} onClick={replay}>{zh ? "回放最近 3 天" : "Replay the last 3 days"}</button>
            {!account && <span className="ag-note">{zh ? "未连接钱包：模拟用占位 owner，结果只在本页。" : "No wallet: the simulation uses a placeholder owner; results stay on this page."}</span>}
          </div>
          {run.kind === "nr" && <NotReady what={"POST /v1/tasks · /v1/replays"} status={run.http} />}
          {run.kind === "ok" && "task" in run.v && <div className="mt-2 space-y-1"><div className="ag-actions"><ModeTag mode="SIMULATION" /><Link className="mono text-xs underline" href={`/agent/tasks/${run.v.task.id}`}>{run.v.task.id}</Link><Pill tone="neutral">{run.v.task.status}</Pill></div><p className="ag-note">{zh ? `阻塞项 ${run.v.task.blockers.length} 个；下次检查 ${run.v.task.nextCheckAt ?? "未知"}。这就是 Agent 会做的事：条件不满足就等，满足了才签发证书。` : `${run.v.task.blockers.length} blocker(s); next check ${run.v.task.nextCheckAt ?? "unknown"}. That is what the agent does: waits while conditions fail, certifies only when they hold.`}</p></div>}
          {run.kind === "ok" && "replay" in run.v && <div className="mt-2 space-y-1"><div className="ag-actions"><ModeTag mode="REPLAY" /><span className="mono text-xs">{run.v.replay.id}</span></div><p className="ag-note">{zh ? `${run.v.replay.points.length} 个评估点，${run.v.replay.gaps.length} 段缺口（缺口如实显示，不补）；只用当时可知的信息，不输出收益。` : `${run.v.replay.points.length} evaluation point(s), ${run.v.replay.gaps.length} gap(s) shown as gaps; only information known at the time, no returns.`}</p></div>}
        </li>
        <li className="ag-step" data-done={account ? "1" : "0"}>
          <h3>{t("ag_connect_last")}</h3>
          <p>{t("ag_connect_why")}</p>
          <div className="ag-actions mt-2">{account ? <Pill tone="ok">{shortKey(account)}</Pill> : <button className="btn-ghost" onClick={() => connect().catch(() => undefined)}>{t("connect")}</button>}<Link className="btn-ghost" href="/agent?entry=buy">{zh ? "去安排一笔真实买入" : "Schedule a real buy"}</Link></div>
        </li>
      </ol>
    </Card>
  );
}
