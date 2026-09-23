"use client";
/** 一张事件卡：事件本体 → 关系 → 资产/持仓 → 命中任务 → 阻塞原因 → 六个动作（各自效果，E-05）。 */
import { useState } from "react";
import type { ImpactAction } from "@chaconne/core/verify";
import { useI18n } from "@/lib/i18n";
import { fmtLocal } from "@/lib/format";
import { Json, Pill } from "@/components/ui";
import { copy, reasonText6, type CopyKey } from "./copy";
import { eventDesk, type ActionResult, type EventDeskItem } from "./api";

const ACTIONS: ImpactAction[] = ["view_evidence", "create_watch_task", "keep_plan", "wait_by_rule", "pause_issuance", "preview_new_plan"];
const REL_TONE: Record<string, "ok" | "warn" | "info" | "neutral"> = { company_direct: "info", user_rule: "warn", macro_research: "neutral" };
const STATUS_TONE: Record<string, "ok" | "warn" | "bad" | "neutral" | "info"> = { estimated: "neutral", confirmed: "ok", revised: "warn", cancelled: "bad", released: "info" };
const EFFECT_TONE: Record<string, "ok" | "warn" | "bad" | "neutral"> = { wait: "warn", recheck: "warn", pause_issuance: "bad", none: "neutral" };

export function EventCard({ item, owner, highlighted, tasksReady }: { item: EventDeskItem; owner: string; highlighted?: boolean; tasksReady: boolean }) {
  const { locale } = useI18n();
  const c = copy(locale);
  const { event: ev, impact } = item;
  const [taskId, setTaskId] = useState<string>(impact.tasks[0]?.taskId ?? "");
  const [busy, setBusy] = useState<ImpactAction | null>(null);
  const [result, setResult] = useState<{ action: ImpactAction; status: number; r: ActionResult | null; error: string | null } | null>(null);

  async function run(action: ImpactAction, extra: { wholeDayIfDayPrecision?: boolean } = {}) {
    setBusy(action);
    const needsTask = action === "wait_by_rule" || action === "pause_issuance";
    const { status, data, error } = await eventDesk.action({ owner, eventId: ev.id, action, taskId: needsTask || (action === "create_watch_task" && taskId) ? taskId || null : null, ...extra });
    setResult({ action, status, r: data, error });
    setBusy(null);
  }

  const when = ev.datePrecision === "exact" && ev.scheduledAtUtc ? fmtLocal(ev.scheduledAtUtc, locale) : `${ev.dateLocal} (${ev.tz})`;
  const kindKey = `kind_${ev.kind}` as CopyKey;
  const relKey = `rel_${impact.relation}` as CopyKey;
  const holdingsUnavailable = !item.impact.holdings.length;
  return (
    <article id={`ev-${ev.id}`} className={`card space-y-3 ${highlighted ? "ring-2 ring-brand-400" : ""}`}>
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Pill tone="brand">{c(kindKey) ?? ev.kind}</Pill>
            <Pill tone={STATUS_TONE[ev.status] ?? "neutral"}>{c(`st_${ev.status}` as CopyKey)}</Pill>
            <Pill tone={REL_TONE[impact.relation] ?? "neutral"}>{c(relKey)}</Pill>
            <Pill tone="neutral">{c(`rv_${item.relevance}` as CopyKey)}</Pill>
          </div>
          <h3 className="mt-2 text-base font-semibold">{ev.name}</h3>
          <p className="text-sm text-fg-2">
            {when} · {c(`precision_${ev.datePrecision}` as CopyKey)}
            {ev.sessionHint ? ` · ${c(`hint_${ev.sessionHint}` as CopyKey)}` : ""}
            {" · "}
            {c("revision")} {ev.revision}
            {ev.revisedFrom ? ` · ${c("revised_from")} ${ev.revisedFrom.dateLocal}` : ""}
          </p>
          <p className="mono text-[11px] text-fg-3">
            {c("source")} {ev.source} · {c("first_known")} {fmtLocal(ev.firstKnownAt, locale)} · {ev.id}
          </p>
        </div>
      </header>

      {impact.relation === "macro_research" && <p className="rounded-md bg-surface-2 p-2 text-xs text-fg-2">{c("macro_note")}</p>}

      <div className="grid gap-3 text-sm md:grid-cols-2">
        <div>
          <div className="text-xs uppercase text-fg-3">{c("assets")}</div>
          {impact.assets.length === 0 ? (
            <div className="text-fg-2">—</div>
          ) : (
            <ul className="mt-1 space-y-1">
              {impact.assets.map((a) => {
                const h = impact.holdings.find((x) => x.assetKey === a);
                return (
                  <li key={a} className="mono break-all text-xs">
                    {a}
                    {h ? <span className="ml-2 text-fg-2">· {c("your_holding")} {h.balanceRaw} raw</span> : holdingsUnavailable ? <span className="ml-2 text-fg-3">· {c("no_holding_data")}</span> : null}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
        <div>
          <div className="text-xs uppercase text-fg-3">{c("tasks_hit")}</div>
          {!tasksReady ? (
            <div className="text-fg-3">{c("no_task_data")}</div>
          ) : impact.tasks.length === 0 ? (
            <div className="text-fg-2">{c("no_task_hit")}</div>
          ) : (
            <ul className="mt-1 space-y-1">
              {impact.tasks.map((t) => {
                const rules = item.rules.filter((r) => r.taskId === t.taskId);
                return (
                  <li key={t.taskId} className="text-xs">
                    <span className="mono">{t.taskId}</span> <Pill tone={EFFECT_TONE[t.effect] ?? "neutral"}>{c(`effect_${t.effect}` as CopyKey)}</Pill>
                    {rules.map((r) => (
                      <div key={r.ruleLabel} className="mono text-[11px] text-fg-2">
                        {r.ruleLabel}
                        {r.window ? ` · ${c("window")} ${fmtLocal(r.window.startUtc, locale)} → ${fmtLocal(r.window.endUtc, locale)}` : r.needsChoice ? ` · ${c("needs_choice")}` : ""}
                        {r.nextCheckAt ? ` · ${c("next_check")} ${fmtLocal(r.nextCheckAt, locale)}` : ""}
                      </div>
                    ))}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {item.blockers.length > 0 && (
        <div className="rounded-md border border-warn/30 bg-warn/8 p-3 text-sm">
          <div className="text-xs uppercase text-warn">{c("blockers")}</div>
          <ul className="mt-1 space-y-1">
            {item.blockers.map((b, i) => (
              <li key={`${b.code}-${i}`}>
                <span className="mono text-[11px] text-fg-3">{b.code}</span> {reasonText6(b.code, locale)}
                {b.nextCheckAt ? <span className="text-fg-2"> · {c("next_check")} {fmtLocal(b.nextCheckAt, locale)}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-2 border-t border-line pt-3">
        {tasksReady && impact.tasks.length > 0 && (
          <label className="flex flex-wrap items-center gap-2 text-xs text-fg-2">
            {c("pick_task")}
            <select className="field h-8 w-auto" value={taskId} onChange={(e) => setTaskId(e.target.value)}>
              <option value="">{c("new_task")}</option>
              {impact.tasks.map((t) => (
                <option key={t.taskId} value={t.taskId}>{t.taskId}</option>
              ))}
            </select>
          </label>
        )}
        <div className="flex flex-wrap gap-2">
          {ACTIONS.map((a) => {
            const enabled = impact.actions.includes(a);
            return (
              <button key={a} type="button" className={`${a === "view_evidence" ? "btn" : "btn-ghost"} h-8 px-3 text-xs`} disabled={!enabled || busy !== null} title={enabled ? undefined : c("action_na")} onClick={() => void run(a)}>
                {busy === a ? "…" : c(`action_${a}` as CopyKey)}
              </button>
            );
          })}
        </div>
        <p className="text-[11px] text-fg-3">{c("no_exec")}</p>
        {result && <ActionOutcome result={result} onWholeDay={() => void run("wait_by_rule", { wholeDayIfDayPrecision: true })} onIgnore={() => void run("keep_plan")} />}
      </div>
    </article>
  );
}

function ActionOutcome({ result, onWholeDay, onIgnore }: { result: { action: ImpactAction; status: number; r: ActionResult | null; error: string | null }; onWholeDay: () => void; onIgnore: () => void }) {
  const { locale } = useI18n();
  const c = copy(locale);
  const [open, setOpen] = useState(false);
  const r = result.r;
  if (!r || (result.error && !r.effect)) {
    return <div className="rounded-md bg-bad/12 p-2 text-xs text-bad">{result.status === 0 || result.status === 502 ? c("unreachable") : `${c(`action_${result.action}` as CopyKey)}: ${result.error ?? `HTTP ${result.status}`}`}</div>;
  }
  const tone = r.effect === "not_ready" ? "bg-warn/12 text-warn" : r.effect === "invalid" ? "bg-bad/12 text-bad" : r.effect === "needs_choice" ? "bg-warn/12 text-fg-1" : "bg-surface-2 text-fg-1";
  return (
    <div className={`rounded-md p-3 text-sm ${tone}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={r.effect === "not_ready" ? "warn" : r.effect === "invalid" ? "bad" : "ok"}>{r.effect === "not_ready" ? c("task_service_not_ready") : r.effect}</Pill>
        {r.mode === "SIMULATION" && <Pill tone="info">{c("sim_only")}</Pill>}
        <span className="mono text-[11px] text-fg-3">executed=false</span>
      </div>
      <p className="mt-1">{r.message[locale]}</p>
      {r.effect === "needs_choice" && (
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" className="btn h-8 px-3 text-xs" onClick={onWholeDay}>{c("whole_day")}</button>
          <button type="button" className="btn-ghost h-8 px-3 text-xs" onClick={onIgnore}>{c("ignore_event")}</button>
        </div>
      )}
      {r.effect === "evidence" && r.evidence && (
        <div className="mt-2">
          <button type="button" className="btn-ghost h-7 px-2 text-xs" onClick={() => setOpen((o) => !o)}>
            {r.evidence.length} {c("evidence_n")} · {open ? c("hide") : c("show_more")}
          </button>
          {open && <Json value={r.evidence} />}
        </div>
      )}
      {(r.effect === "preview" || r.effect === "draft" || r.effect === "created" || r.effect === "attached") && (r.preview !== undefined || r.draft !== undefined) && (
        <div className="mt-2">
          <button type="button" className="btn-ghost h-7 px-2 text-xs" onClick={() => setOpen((o) => !o)}>{open ? c("hide") : c("show_more")}</button>
          {open && <Json value={r.preview ?? r.draft} />}
        </div>
      )}
      {r.blockers && r.blockers.length > 0 && r.effect !== "needs_choice" && (
        <ul className="mt-2 space-y-1 text-xs">
          {r.blockers.map((b, i) => (
            <li key={`${b.code}-${i}`}><span className="mono text-fg-3">{b.code}</span> {reasonText6(b.code, locale)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
