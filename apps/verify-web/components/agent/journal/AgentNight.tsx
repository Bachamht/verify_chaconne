"use client";
/**
 * P5：夜班日志的 Chaconne Agent 段（只在 NEXT_PUBLIC_V7_UI=1 时挂载）：看了什么 / 做了什么 / 为什么没做 / 下一步观察什么，
 * 加轮次数、成交、模型成本、故障与恢复。数据来自 Lane R（R4）：recap 响应的 `agent` 字段（AgentJournalDay，见 lib/api-v2 AgentJournalDayView），
 * 在这里换算成四段；没有该字段时说明「还没有接入」，示例结构折叠显示并标 FIXTURE，绝不当真实记录。
 */
import type { AgentJournalDayView, RecapView } from "@/lib/api-v2";
import type { Locale } from "@/lib/i18n";
import { tv } from "@/lib/i18n.v7";
import { formatTime } from "@/lib/format";
import { Card, Pill } from "@/components/ui";
import { ModeTag } from "../shared";
import { useV7 } from "../tasks/v7/useV7";
import { fxAgentNight, type AgentNightView } from "@/lib/v7fixtures";
import "../v7.css";

/** Lane R 的 AgentJournalDay → 四段（看了什么 = 工具调用短句；做了什么 = 成交与交易意图；为什么没做 = 等待理由；下一步 = 最近的下次检查与改主意条件） */
export function nightFromJournal(a: AgentJournalDayView, locale: Locale): AgentNightView {
  const uniq = (xs: Array<string | null | undefined>, max = 8) => [...new Set(xs.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim()))].slice(0, max);
  const t = (iso: string) => formatTime(iso, locale);
  const actions = Array.isArray(a.actions?.items) ? a.actions.items : [];
  const runs = Array.isArray(a.runs?.items) ? a.runs.items : [];
  const fills = Array.isArray(a.fills) ? a.fills : [];
  const waits = Array.isArray(a.waits) ? a.waits : [];
  const looked = uniq(actions.filter((x) => x.type === "agent_tool").map((x) => x.note));
  const did = [
    ...fills.map((f) => tv(locale, "j_fill_line", { side: tv(locale, f.side === "sell" ? "j_sell" : "j_buy"), n: f.stepIndex + 1, at: t(f.at) })),
    ...uniq(runs.filter((r) => r.action?.kind === "intent").map((r) => r.decisionSummary)),
  ].slice(0, 10);
  const skipped = uniq(waits.map((w) => w.note ?? w.invalidation));
  const lastRun = [...runs].sort((x, y) => Date.parse(y.at) - Date.parse(x.at))[0];
  const lastWait = [...waits].sort((x, y) => Date.parse(y.at) - Date.parse(x.at))[0];
  const next = uniq([
    lastRun?.nextCheckAt ? tv(locale, "j_next_check", { at: t(lastRun.nextCheckAt) }) : null,
    lastWait?.invalidation ?? null,
    lastWait?.nextCheckAt && lastWait.nextCheckAt !== lastRun?.nextCheckAt ? tv(locale, "j_next_check", { at: t(lastWait.nextCheckAt) }) : null,
  ]);
  const modes = Object.keys(a.runs?.byMode ?? {});
  return {
    date: a.date,
    mode: modes.length === 1 && modes[0] === "SIMULATION" ? "SIMULATION" : "LIVE",
    runs: Number(a.runs?.total ?? runs.length) || 0,
    fills: { buy: fills.filter((f) => f.side !== "sell").length, sell: fills.filter((f) => f.side === "sell").length },
    costUsdMicros: String(a.cost?.totalUsdMicros ?? "0"),
    sections: { looked, did, skipped, next },
    faults: [
      ...(a.faults ?? []).map((f) => ({ at: f.at, kind: f.type, text: f.note ?? "", recovered: false, event: "fault" as const })),
      ...(a.recoveries ?? []).map((f) => ({ at: f.at, kind: f.type, text: f.note ?? "", recovered: true, event: "recovery" as const })),
    ].sort((x, y) => Date.parse(x.at) - Date.parse(y.at)),
  };
}

export function agentNightOf(recap: unknown, locale: Locale = "zh"): AgentNightView | null {
  if (!recap || typeof recap !== "object") return null;
  const r = recap as { agent?: unknown; agentNight?: unknown };
  const raw = (r.agent ?? r.agentNight) as Record<string, unknown> | undefined;
  if (!raw || typeof raw !== "object") return null;
  if (raw["runs"] && typeof raw["runs"] === "object" && "total" in (raw["runs"] as object)) return nightFromJournal(raw as unknown as AgentJournalDayView, locale);
  const a = raw as Partial<AgentNightView>;
  if (!a.sections) return null;
  const list = (x: unknown) => (Array.isArray(x) ? x.filter((v): v is string => typeof v === "string") : []);
  return {
    date: String(a.date ?? (recap as { date?: string }).date ?? ""),
    mode: a.mode === "SIMULATION" || a.mode === "FIXTURE" ? a.mode : "LIVE",
    runs: Number(a.runs ?? 0) || 0,
    fills: { buy: Number(a.fills?.buy ?? 0) || 0, sell: Number(a.fills?.sell ?? 0) || 0 },
    costUsdMicros: String(a.costUsdMicros ?? "0"),
    sections: { looked: list(a.sections.looked), did: list(a.sections.did), skipped: list(a.sections.skipped), next: list(a.sections.next) },
    faults: Array.isArray(a.faults) ? a.faults.filter((f) => f && typeof f === "object").map((f) => ({ at: String(f.at ?? ""), kind: String(f.kind ?? ""), text: String(f.text ?? ""), recovered: f.recovered === true })) : [],
  };
}

export function AgentNight({ recap, fixture = false }: { recap: RecapView | null; fixture?: boolean }) {
  const { s, locale } = useV7();
  const real = fixture ? null : agentNightOf(recap, locale);
  if (fixture) return <NightBody n={fxAgentNight()} />;
  if (real) return <NightBody n={real} />;
  return (
    <Card title={s("j_h")} right={<ModeTag mode="FIXTURE" />}>
      <p className="ag-note">{s("j_missing")}</p>
      <details className="mt-2"><summary className="cursor-pointer text-sm">{s("fixture_note")}</summary><div className="mt-3"><NightBody n={fxAgentNight()} bare /></div></details>
    </Card>
  );
}

function NightBody({ n, bare = false }: { n: AgentNightView; bare?: boolean }) {
  const { s, locale } = useV7();
  const usd = (Number(n.costUsdMicros) / 1e6).toFixed(2);
  const section = (k: "j_looked" | "j_did" | "j_skipped" | "j_next", items: string[]) => <section><h3>{s(k)}</h3>{items.length ? <ul>{items.map((x, i) => <li key={i}>{x}</li>)}</ul> : <p className="ag-note">{s("j_empty_section")}</p>}</section>;
  const body = (
    <div className="space-y-3" data-testid="agent-night">
      <div className="v7-stats">
        <div><span>{s("j_runs")}</span><strong>{n.runs}</strong></div>
        <div><span>{s("j_fills")}</span><strong>{n.fills.buy + n.fills.sell}</strong><span>{locale === "zh" ? `买 ${n.fills.buy} · 卖 ${n.fills.sell}` : `${n.fills.buy} buy · ${n.fills.sell} sell`}</span></div>
        <div><span>{s("j_cost")}</span><strong>${usd}</strong></div>
      </div>
      <div className="v7-night">
        {section("j_looked", n.sections.looked)}
        {section("j_did", n.sections.did)}
        {section("j_skipped", n.sections.skipped)}
        {section("j_next", n.sections.next)}
      </div>
      <div>
        <h3 className="text-sm font-semibold">{s("j_faults")}</h3>
        {n.faults.length === 0 ? <p className="ag-note">{s("j_no_faults")}</p> : (
          <ul className="ag-list">{n.faults.map((f, i) => <li key={i}><div className="ag-actions"><Pill tone={f.event === "fault" ? "warn" : f.event === "recovery" ? "ok" : f.recovered ? "ok" : "bad"}>{f.event === "fault" ? s("j_fault") : f.event === "recovery" ? s("j_recovery") : f.recovered ? s("j_recovered") : s("j_unresolved")}</Pill><span className="mono text-xs">{f.kind}</span><span className="ag-note">{f.at ? formatTime(f.at, locale) : ""}</span></div><p className="text-sm">{f.text}</p></li>)}</ul>
        )}
      </div>
      <p className="ag-note">{s("proof_scope")}</p>
    </div>
  );
  if (bare) return body;
  return <Card title={`${s("j_h")}${n.date ? ` · ${n.date}` : ""}`} right={<ModeTag mode={n.mode} />}>{body}</Card>;
}
