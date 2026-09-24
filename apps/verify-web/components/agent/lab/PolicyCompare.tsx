"use client";
/**
 * 「双策略对照」（C9 · L-02 / L-06）：两套规则在同一证据快照上并排试算；SIMULATION，不改真实任务、不写授权。
 * 命名固定为「双策略对照」——只有两个真实 Agent 输出时才叫多 Agent（上游 C9）。
 */
import { useState } from "react";
import Link from "next/link";
import type { Condition } from "@chaconne/core/verify";
import { useI18n } from "@/lib/i18n";
import { fmtLocal } from "@/lib/format";
import { conditionText } from "@/lib/conditions";
import { apiError } from "@/lib/errors";
import { remember } from "@/lib/history";
import { Card, Json, Pill, Row } from "@/components/ui";
import { blockerSentence } from "../tasks/taskTitle";
import { lab, type CompareView } from "./api";
import { outcomeLabel } from "./WaitDiagnosis";
import { bothWaitingForOpen } from "./compareHints";

interface VariantForm { label: string; afterMin: number; beforeMin: number; wholeDay: boolean; maxVix: string }
const DEFAULT_A: VariantForm = { label: "wait20", afterMin: 20, beforeMin: 30, wholeDay: true, maxVix: "" };
const DEFAULT_B: VariantForm = { label: "wait40", afterMin: 40, beforeMin: 30, wholeDay: true, maxVix: "" };

function toItems(v: VariantForm): Condition[] {
  const items: Condition[] = [
    { type: "session", allow: ["US_REGULAR"] },
    { type: "avoid_event_window", kinds: ["MACRO_TIER1"], beforeMin: v.beforeMin, afterMin: v.afterMin, includeEstimated: true, wholeDayIfDayPrecision: v.wholeDay },
  ];
  const vix = Number(v.maxVix);
  if (v.maxVix.trim() && Number.isFinite(vix) && vix > 0) items.push({ type: "max_vix", value: vix });
  return items;
}

const TONE: Record<string, "ok" | "warn" | "info"> = { SATISFIED: "ok", UNSATISFIED: "warn", INSUFFICIENT_EVIDENCE: "info" };

export function PolicyCompare({ taskId }: { taskId: string }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const [a, setA] = useState<VariantForm>(DEFAULT_A);
  const [b, setB] = useState<VariantForm>(DEFAULT_B);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [d, setD] = useState<CompareView | null>(null);
  const [simId, setSimId] = useState<string | null>(null);
  const [simErr, setSimErr] = useState<string | null>(null);

  async function run() {
    if (!taskId) return;
    setBusy(true);
    setErr(null);
    setSimId(null);
    const r = await lab.compare(taskId, [
      { label: a.label || "A", conditions: { items: toItems(a) } },
      { label: b.label || "B", conditions: { items: toItems(b) } },
    ]);
    setBusy(false);
    if ((r.status === 201 || r.status === 200) && r.data && typeof r.data === "object") setD(r.data);
    else {
      setD(null);
      setErr(apiError(r, locale));
    }
  }
  async function remix() {
    if (!d?.remix?.simulationBody) return;
    setSimErr(null);
    const r = await lab.simulate(d.remix.simulationBody);
    if (r.status === 201) {
      setSimId(r.data.simulationId);
      remember({ kind: "simulation", id: r.data.simulationId, title: `${zh ? "由对照建的模拟" : "Simulation from comparison"} ${d.comparisonId}` });
    } else setSimErr(apiError(r, locale));
  }

  const editor = (v: VariantForm, set: (x: VariantForm) => void, title: string) => (
    <div className="rounded-md border border-line bg-surface-2 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-sm font-semibold">{title}</span>
        <input className="field h-8 w-28 text-xs" value={v.label} onChange={(e) => set({ ...v, label: e.target.value })} aria-label="label" />
      </div>
      <label className="block text-xs text-fg-2">
        {zh ? "一级宏观事件后等待（分钟）" : "Wait after Tier-1 macro event (min)"}
        <input className="field mt-1" type="number" min={0} max={720} value={v.afterMin} onChange={(e) => set({ ...v, afterMin: Number(e.target.value) })} />
      </label>
      <label className="mt-2 block text-xs text-fg-2">
        {zh ? "事件前回避（分钟）" : "Avoid before event (min)"}
        <input className="field mt-1" type="number" min={0} max={720} value={v.beforeMin} onChange={(e) => set({ ...v, beforeMin: Number(e.target.value) })} />
      </label>
      <label className="mt-2 block text-xs text-fg-2">
        {zh ? "VIX 上限（留空 = 不限）" : "Max VIX (blank = none)"}
        <input className="field mt-1" inputMode="decimal" value={v.maxVix} onChange={(e) => set({ ...v, maxVix: e.target.value })} placeholder="—" />
      </label>
      <label className="mt-2 flex items-center gap-2 text-xs text-fg-2">
        <input type="checkbox" checked={v.wholeDay} onChange={(e) => set({ ...v, wholeDay: e.target.checked })} />
        {zh ? "事件只有日期精度时整日等待" : "Wait the whole day when the event has day precision"}
      </label>
    </div>
  );

  return (
    <Card className="scroll-mt-24" title={<span id="compare">{zh ? "双策略对照 · 换一种规则会怎样？" : "Two-policy comparison · What if the rule were different?"}</span>} right={<Pill tone="warn">SIMULATION</Pill>}>
      <p className="mb-3 text-sm text-fg-2">{zh ? "两套规则看同一份证据快照（同资产、同资金基准、同费用假设、同事件版本），并排给出放行/等待与逐项差异。不改你的授权、不改真实任务。" : "Both rule sets see one fixed evidence snapshot (same asset, budget basis, fee assumptions and event versions) and are shown side by side with their differences. Your authorization and the real task are untouched."}</p>
      {!taskId && <p className="text-xs text-fg-3">{zh ? "先在上方诊断一个任务，对照会固定它最近一次评估的证据快照。" : "Diagnose a task above first; the comparison pins its latest evaluation snapshot."}</p>}
      <div className="grid gap-3 md:grid-cols-2">
        {editor(a, setA, zh ? "策略 A" : "Policy A")}
        {editor(b, setB, zh ? "策略 B" : "Policy B")}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button className="btn" type="button" disabled={busy || !taskId} onClick={() => void run()}>{busy ? "…" : zh ? "同快照对照" : "Compare on the same snapshot"}</button>
        <span className="text-xs text-fg-3">{zh ? "两套都固定 session=US_REGULAR。" : "Both fix session=US_REGULAR."}</span>
      </div>
      {err && <p className="mt-3 text-sm text-warn">{zh ? "不可用：" : "Unavailable: "}{err}</p>}
      {d && (
        <div className="mt-4 space-y-4">
          {bothWaitingForOpen(d.outcomeDiff) && <p className="ag-warn">{zh ? "现在两套方案都在等开盘（美股不在常规时段）；开盘后再对照，差异才有意义。" : "Both policies are waiting for the open right now (US market outside regular hours); the difference only means something once it opens."}</p>}
          <div className="grid gap-x-6 md:grid-cols-2">
            <Row k={zh ? "证据快照" : "Evidence snapshot"} v={<details className="inline-block text-left"><summary className="cursor-pointer">{zh ? `${d.snapshot?.id ? d.snapshot.id.slice(0, 14) + "…" : "—"} · ${(d.snapshot?.eventVersions ?? []).length} 个事件版本 · ${d.snapshot?.evidenceIds?.length ?? 0} 条证据` : `${d.snapshot?.id ? d.snapshot.id.slice(0, 14) + "…" : "—"} · ${(d.snapshot?.eventVersions ?? []).length} event version(s) · ${d.snapshot?.evidenceIds?.length ?? 0} evidence record(s)`}</summary><div className="mono mt-1 max-h-40 overflow-auto text-xs text-fg-3">{d.snapshot?.id}{(d.snapshot?.eventVersions ?? []).map((e) => <div key={e.id}>{e.id}#{e.revision}</div>)}</div></details>} />
            <Row k={zh ? "快照时刻" : "Snapshot at"} v={d.snapshot?.takenAt ? fmtLocal(d.snapshot.takenAt, locale) : "—"} />
            <Row k={zh ? "真实任务" : "Real task"} v={d.task ? `${d.task.status} · ${zh ? "条件未改动、未写任何授权" : "conditions untouched, no authorization written"}` : "—"} />
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            {(d.outcomeDiff ?? []).map((o, i) => (
              <div key={o.label} className="rounded-md border border-line p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-semibold">{o.label}</span>
                  <Pill tone={TONE[o.outcome] ?? "neutral"}>{outcomeLabel(o.outcome, zh)}</Pill>
                </div>
                <div className="mt-2 text-xs text-fg-2">
                  {(o.blockingCodes ?? []).length === 0 ? <div>{zh ? "没有阻塞项" : "No blockers"}</div> : <ul className="space-y-0.5">{(o.blockingCodes ?? []).map((c) => <li key={c}>· {blockerSentence({ code: c }, locale)}</li>)}</ul>}
                  <div className="mt-1">{zh ? "下次检查" : "Next check"}: {o.nextCheckAt ? fmtLocal(o.nextCheckAt, locale) : zh ? "未知" : "unknown"}</div>
                  {d.planner?.[i]?.summary ? (
                    <div>{zh ? "规划器（同一报价）" : "Planner (same quote)"}: {d.planner[i]!.summary!.candidateCount} {zh ? "个候选" : "candidate(s)"} · {d.planner[i]!.summary!.verdict ?? (zh ? "暂无推荐" : "no recommendation yet")}</div>
                  ) : (
                    <div>{zh ? "规划器：不可用" : "Planner: unavailable"}</div>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div>
            <h3 className="text-sm font-semibold">{zh ? "逐项差异" : "Item-by-item diff"}</h3>
            {(d.comparison?.diff ?? []).length === 0 ? (
              <p className="text-xs text-fg-3">{zh ? "两套条件没有差异。" : "No differences between the two sets."}</p>
            ) : (
              <div className="mt-1 overflow-x-auto">
                <table className="w-full text-left text-xs">
                  <thead><tr className="text-fg-3"><th className="py-1 pr-3 font-medium">{zh ? "字段" : "Field"}</th><th className="py-1 pr-3 font-medium">A · {a.label || "A"}</th><th className="py-1 font-medium">B · {b.label || "B"}</th></tr></thead>
                  <tbody>{(d.comparison?.diff ?? []).map((x) => <tr key={x.itemType} className="border-t border-line align-top"><td className="py-1 pr-3 font-semibold">{x.itemType}</td><td className="py-1 pr-3">{sideText(x.a, locale)}</td><td className="py-1">{sideText(x.b, locale)}</td></tr>)}</tbody>
                </table>
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button className="btn-ghost" type="button" disabled={!d.remix?.simulationBody} onClick={() => void remix()}>{zh ? `用 ${d.remix?.variantLabel ?? "A"} 建一个模拟` : `Create a simulation from ${d.remix?.variantLabel ?? "A"}`}</button>
            {simId && <Link href={`/play?simulation=${simId}`} className="text-sm underline">{zh ? "查看模拟" : "View simulation"} {simId}</Link>}
            {simErr && <span className="text-sm text-warn">{simErr}</span>}
          </div>
          {d.note && <p className="text-xs text-fg-3">{zh ? d.note.zh : d.note.en}</p>}
          <details><summary className="cursor-pointer text-xs text-fg-3">{zh ? "开发者视图（原始响应）" : "Developer view (raw response)"}</summary><Json value={d} /></details>
        </div>
      )}
    </Card>
  );
}

/** diff 的一侧：条件项 → 句子；缺失 → 「无此项」；其它值原样 */
function sideText(v: unknown, locale: "en" | "zh"): string {
  if (v === null || v === undefined) return locale === "zh" ? "无此项" : "not set";
  if (typeof v === "object" && v !== null && "type" in v) {
    try { return conditionText(v as Condition, locale); } catch { /* fallthrough */ }
  }
  return typeof v === "string" ? v : JSON.stringify(v);
}
