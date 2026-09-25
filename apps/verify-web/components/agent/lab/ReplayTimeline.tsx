"use client";
/**
 * 决策回放时间线（C9 · L-03～L-05）：放行 / 等待 / 证据不足三色 + 缺口灰带；只用各时点已知数据；不输出收益。
 * 颜色全部走 globals.css token（ok / warn / info / surface-2）。
 */
import { useEffect, useMemo, useState } from "react";
import type { Condition } from "@chaconne/core/verify";
import { api, type AssetsResponse } from "@/lib/api";
import { useI18n } from "@/lib/i18n";
import { fmtLocal } from "@/lib/format";
import { apiError } from "@/lib/errors";
import { useMounted } from "@/lib/useMounted";
import { Card, Pill } from "@/components/ui";
import { lab, type ReplayView } from "./api";
import { outcomeLabel } from "./WaitDiagnosis";

/** Date → `YYYY-MM-DDTHH:mm`（浏览器本地时区，datetime-local 输入框的口径） */
function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
const BAR: Record<string, string> = { SATISFIED: "bg-ok", UNSATISFIED: "bg-warn", INSUFFICIENT_EVIDENCE: "bg-info" };
const GAP_LABEL: Record<string, { en: string; zh: string }> = {
  NO_ARCHIVE: { en: "no archive", zh: "无档案" },
  NO_QUOTE: { en: "no quote", zh: "无报价" },
  REFERENCE_PURGED: { en: "reference purged (feed outage)", zh: "参考价断供清空" },
};

export function ReplayTimeline({ initialAsset, initialDate }: { initialAsset?: string | null; initialDate?: string | null } = {}) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const mounted = useMounted();
  const [assets, setAssets] = useState<AssetsResponse | null>(null);
  const [assetKey, setAssetKey] = useState(initialAsset ?? "");
  const [playbookId, setPlaybookId] = useState("session_dca");
  const [afterMin, setAfterMin] = useState(20);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [step, setStep] = useState(60);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [d, setD] = useState<ReplayView | null>(null);
  const [sel, setSel] = useState<number | null>(null);

  useEffect(() => {
    api<AssetsResponse>("GET", "v1/assets").then((r) => {
      if (r.status !== 200) return;
      setAssets(r.data);
      const first = r.data.assets.find((a) => a.role === "stock_output" && a.executionAllowed);
      setAssetKey((cur) => cur || first?.assetKey || "");
    });
  }, []);
  // 水合安全：默认区间挂载后再填（最近 3 天，到当前时刻为止）。datetime-local 取本地时间，不能塞 UTC 串
  useEffect(() => {
    if (!from && !to) {
      if (initialDate && /^\d{4}-\d{2}-\d{2}$/.test(initialDate)) {
        setFrom(`${initialDate}T00:00`);
        setTo(`${initialDate}T23:59`);
        return;
      }
      const now = Date.now();
      setTo(toLocalInput(now - 60_000));
      setFrom(toLocalInput(now - 3 * 86_400_000));
    }
  }, [from, to, initialDate]);

  const items = useMemo<Condition[]>(
    () => (playbookId === "discount_watch"
      ? [{ type: "session", allow: ["US_REGULAR"] }, { type: "premium_bps_lte", value: 50, referenceKind: "live", liveOnlyForExecution: true }]
      : [{ type: "session", allow: ["US_REGULAR"] }, { type: "avoid_event_window", kinds: ["MACRO_TIER1"], beforeMin: 30, afterMin, includeEstimated: true, wholeDayIfDayPrecision: true }]),
    [playbookId, afterMin],
  );

  async function run() {
    setBusy(true);
    setErr(null);
    setSel(null);
    const r = await lab.replay({ playbookId, assetKey, conditions: { items }, from: new Date(from).toISOString(), to: new Date(to).toISOString(), stepMinutes: step, locale });
    setBusy(false);
    if (r.status === 201) setD(r.data);
    else {
      setD(null);
      setErr(apiError(r, locale));
    }
  }

  const run_ = d?.run ?? null;
  const span = run_ ? Math.max(1, Date.parse(run_.to) - Date.parse(run_.from)) : 1;
  const pct = (iso: string) => `${Math.min(100, Math.max(0, ((Date.parse(iso) - Date.parse(run_!.from)) / span) * 100))}%`;
  const width = (a: string, b: string) => `${Math.max(0.5, ((Date.parse(b) - Date.parse(a)) / span) * 100)}%`;
  const counts = run_ ? run_.points.reduce<Record<string, number>>((m, p) => ({ ...m, [p.outcome]: (m[p.outcome] ?? 0) + 1 }), {}) : {};

  return (
    <Card className="scroll-mt-24" title={<span id="replay">{zh ? "决策回放 · 当时已知的数据会让哪条规则放行？" : "Decision replay · Which rule would have passed on what was known then?"}</span>} right={<Pill tone="warn">REPLAY</Pill>}>
      <p className="mb-3 text-sm text-fg-2">{zh ? "每个评估点只用当时已可知的证据、上下文与事件版本（后来的修订不用）。没有档案的区间显示为灰带，不补值；这不是收益回测，也不显示收益。" : "Each point uses only evidence, context and event versions known at that time (later revisions are not used). Intervals without an archive appear as grey bands and are never filled in. This is not a backtest and reports no returns."}</p>
      <div className="grid gap-2 md:grid-cols-3">
        <label className="text-xs text-fg-2">
          {zh ? "资产" : "Asset"}
          <select className="field mt-1" value={assetKey} onChange={(e) => setAssetKey(e.target.value)}>
            {!assets && <option value="">{zh ? "加载中…" : "Loading…"}</option>}
            {assets?.assets.filter((a) => a.role === "stock_output").map((a) => <option key={a.assetKey} value={a.assetKey}>{a.displaySymbol}{a.executionAllowed ? "" : zh ? "（未放行）" : " (not allowed)"}</option>)}
          </select>
        </label>
        <label className="text-xs text-fg-2">
          {zh ? "模板" : "Playbook"}
          <select className="field mt-1" value={playbookId} onChange={(e) => setPlaybookId(e.target.value)}>
            <option value="session_dca">session_dca</option>
            <option value="event_aware_accumulate">event_aware_accumulate</option>
            <option value="discount_watch">discount_watch</option>
          </select>
        </label>
        <label className="text-xs text-fg-2">
          {zh ? "事件后等待（分钟）" : "Wait after event (min)"}
          <input className="field mt-1" type="number" min={0} max={720} value={afterMin} disabled={playbookId === "discount_watch"} onChange={(e) => setAfterMin(Number(e.target.value))} />
        </label>
        <label className="text-xs text-fg-2">
          {zh ? "从" : "From"}
          {mounted && <input className="field mt-1" type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} />}
        </label>
        <label className="text-xs text-fg-2">
          {zh ? "到" : "To"}
          {mounted && <input className="field mt-1" type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} />}
        </label>
        <label className="text-xs text-fg-2">
          {zh ? "步长（分钟）" : "Step (min)"}
          <input className="field mt-1" type="number" min={5} max={1440} value={step} onChange={(e) => setStep(Number(e.target.value))} />
        </label>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button className="btn" type="button" disabled={busy || !assetKey || !from || !to} onClick={() => void run()}>{busy ? "…" : zh ? "回放" : "Replay"}</button>
        <span className="mono text-xs text-fg-3">{items.map((i) => i.type).join(" + ")}</span>
      </div>
      {err && <p className="mt-3 text-sm text-warn">{zh ? "不可用：" : "Unavailable: "}{err}</p>}
      {run_ && d && (
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap gap-3 text-xs">
            <span className="inline-flex items-center gap-1"><i className="inline-block h-3 w-3 rounded-xs bg-ok" />{outcomeLabel("SATISFIED", zh)} {counts["SATISFIED"] ?? 0}</span>
            <span className="inline-flex items-center gap-1"><i className="inline-block h-3 w-3 rounded-xs bg-warn" />{outcomeLabel("UNSATISFIED", zh)} {counts["UNSATISFIED"] ?? 0}</span>
            <span className="inline-flex items-center gap-1"><i className="inline-block h-3 w-3 rounded-xs bg-info" />{outcomeLabel("INSUFFICIENT_EVIDENCE", zh)} {counts["INSUFFICIENT_EVIDENCE"] ?? 0}</span>
            <span className="inline-flex items-center gap-1"><i className="inline-block h-3 w-3 rounded-xs bg-surface-2 ring-1 ring-line-strong" />{zh ? "缺口" : "gap"} {run_.gaps.length}</span>
          </div>
          {/* 评估点条 */}
          <div className="relative h-8 w-full overflow-hidden rounded-md bg-surface-0 ring-1 ring-line" role="list" aria-label={zh ? "评估点" : "evaluation points"}>
            {run_.points.map((p, i) => (
              <button
                key={p.t}
                type="button"
                role="listitem"
                title={`${fmtLocal(p.t, locale)} · ${outcomeLabel(p.outcome, zh)}`}
                aria-label={`${p.t} ${p.outcome}`}
                onClick={() => setSel(i)}
                className={`absolute top-0 h-full ${BAR[p.outcome] ?? "bg-fg-3"} ${sel === i ? "ring-2 ring-fg-1" : ""}`}
                style={{ left: pct(p.t), width: `max(3px, ${width(p.t, run_.points[i + 1]?.t ?? run_.to)})` }}
              />
            ))}
          </div>
          {/* 缺口灰带 */}
          <div className="relative h-3 w-full overflow-hidden rounded-sm bg-surface-1 ring-1 ring-line" aria-label={zh ? "缺口" : "gaps"}>
            {run_.gaps.map((g, i) => (
              <div key={`${g.reason}-${i}`} title={`${zh ? GAP_LABEL[g.reason]?.zh : GAP_LABEL[g.reason]?.en} · ${fmtLocal(g.from, locale)} → ${fmtLocal(g.to, locale)}`} className="absolute top-0 h-full bg-surface-2 ring-1 ring-line-strong" style={{ left: pct(g.from), width: width(g.from, g.to) }} />
            ))}
          </div>
          <div className="mono flex justify-between text-xs text-fg-3">
            <span>{fmtLocal(run_.from, locale)}</span>
            <span>{fmtLocal(run_.to, locale)}</span>
          </div>
          {sel !== null && run_.points[sel] && (
            <div className="rounded-md border border-line bg-surface-2 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="mono text-xs text-fg-2">{fmtLocal(run_.points[sel]!.t, locale)}</span>
                <Pill tone={run_.points[sel]!.outcome === "SATISFIED" ? "ok" : run_.points[sel]!.outcome === "UNSATISFIED" ? "warn" : "info"}>{outcomeLabel(run_.points[sel]!.outcome, zh)}</Pill>
                <span className="mono text-xs text-fg-3">{zh ? "用到的最晚可知时刻" : "known as of"}: {fmtLocal(run_.points[sel]!.knownAsOf, locale)}</span>
              </div>
              {run_.points[sel]!.blockers.length === 0 ? (
                <p className="mt-1 text-xs text-fg-3">{zh ? "该点没有阻塞项。" : "No blockers at this point."}</p>
              ) : (
                <ul className="mt-2 space-y-1 text-xs">
                  {run_.points[sel]!.blockers.map((b, i) => (
                    <li key={`${b.code}-${i}`}><span className="mono">{b.code}</span> · {b.text}</li>
                  ))}
                </ul>
              )}
            </div>
          )}
          <div className="grid gap-x-6 text-xs md:grid-cols-2">
            <div>
              <h3 className="text-sm font-semibold">{zh ? "覆盖区间" : "Coverage"}</h3>
              {run_.coverage.length === 0 ? <p className="text-fg-3">{zh ? "没有任何覆盖：这段时间没有档案。" : "No coverage: nothing archived in this range."}</p> : (
                <ul className="mono mt-1 space-y-0.5 text-fg-2">
                  {run_.coverage.map((c, i) => <li key={i}>{fmtLocal(c.from, locale)} → {fmtLocal(c.to, locale)} · {c.sources.join(", ")}</li>)}
                </ul>
              )}
            </div>
            <div>
              <h3 className="text-sm font-semibold">{zh ? "缺口（如实）" : "Gaps (as found)"}</h3>
              {run_.gaps.length === 0 ? <p className="text-fg-3">{zh ? "无缺口。" : "No gaps."}</p> : (
                <ul className="mono mt-1 space-y-0.5 text-fg-2">
                  {run_.gaps.map((g, i) => <li key={i}>{fmtLocal(g.from, locale)} → {fmtLocal(g.to, locale)} · {zh ? GAP_LABEL[g.reason]?.zh : GAP_LABEL[g.reason]?.en} ({g.reason})</li>)}
                </ul>
              )}
            </div>
          </div>
          <p className="text-xs text-fg-3">
            {zh ? `用到的数据：证据 ${d.sources?.verify_evidence ?? 0} 条 · 上下文快照 ${d.sources?.verify_context_snapshots ?? 0} 份 · 溢价小时线 ${d.sources?.premium_1h ?? 0} 条（只作背景）· 事件 ${d.sources?.events ?? 0} 个` : `Data used: ${d.sources?.verify_evidence ?? 0} evidence record(s) · ${d.sources?.verify_context_snapshots ?? 0} context snapshot(s) · ${d.sources?.premium_1h ?? 0} hourly premium point(s) (background only) · ${d.sources?.events ?? 0} event(s)`}
          </p>
          <p className="text-xs text-fg-3">{zh ? d.note.zh : d.note.en}</p>
        </div>
      )}
    </Card>
  );
}
