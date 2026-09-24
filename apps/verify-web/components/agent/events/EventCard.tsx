"use client";
/**
 * 一张事件卡（V-34）：事件本体 → 关系 → 资产/持仓 → 命中任务 → 阻塞原因 → **一个主动作 + 「更多」**。
 * 不适用的动作不显示，只留一行原因；「查看依据」0 条时写明「暂无证据，这是估计日期」；「预览新计划」用句子而不是 JSON；
 * 内部 id / 来源串只在「开发者视图」。
 */
import Link from "next/link";
import { useState } from "react";
import type { Condition, ImpactAction } from "@chaconne/core/verify";
import { useI18n } from "@/lib/i18n";
import { formatAmount, formatTime } from "@/lib/format";
import { conditionText } from "@/lib/conditions";
import { assetByKey, type AssetEntry } from "@/lib/assets";
import { Json, Pill } from "@/components/ui";
import { copy, reasonText6, type CopyKey } from "./copy";
import { eventDesk, type ActionResult, type EventDeskItem } from "./api";
import { primaryActionOf } from "./primaryAction";

const ACTIONS: ImpactAction[] = ["view_evidence", "create_watch_task", "keep_plan", "wait_by_rule", "pause_issuance", "preview_new_plan"];
const REL_TONE: Record<string, "ok" | "warn" | "info" | "neutral"> = { company_direct: "info", user_rule: "warn", macro_research: "neutral" };
const STATUS_TONE: Record<string, "ok" | "warn" | "bad" | "neutral" | "info"> = { estimated: "neutral", confirmed: "ok", revised: "warn", cancelled: "bad", released: "info" };
const EFFECT_TONE: Record<string, "ok" | "warn" | "bad" | "neutral"> = { wait: "warn", recheck: "warn", pause_issuance: "bad", none: "neutral" };
const SOURCE_NAME: Record<string, string> = { "crowsnest.fred": "FRED", "crowsnest.eia": "EIA", "crowsnest.fedcal": "Fed calendar", "crowsnest.bls": "BLS", "crowsnest.bea": "BEA", finnhub: "Finnhub", "crowsnest.finnhub": "Finnhub", "crowsnest.nyse": "NYSE calendar" };


export function EventCard({ item, owner, highlighted, tasksReady, assets = [] }: { item: EventDeskItem; owner: string; highlighted?: boolean; tasksReady: boolean; assets?: AssetEntry[] }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const c = copy(locale);
  const { event: ev, impact } = item;
  const [taskId, setTaskId] = useState<string>(impact.tasks[0]?.taskId ?? "");
  const [busy, setBusy] = useState<ImpactAction | null>(null);
  const [more, setMore] = useState(false);
  const [result, setResult] = useState<{ action: ImpactAction; status: number; r: ActionResult | null; error: string | null } | null>(null);

  async function run(action: ImpactAction, extra: { wholeDayIfDayPrecision?: boolean } = {}) {
    setBusy(action);
    const needsTask = action === "wait_by_rule" || action === "pause_issuance";
    const { status, data, error } = await eventDesk.action({ owner, eventId: ev.id, action, taskId: needsTask || (action === "create_watch_task" && taskId) ? taskId || null : null, ...extra });
    setResult({ action, status, r: data, error });
    setBusy(null);
  }

  const when = ev.datePrecision === "exact" && ev.scheduledAtUtc ? formatTime(ev.scheduledAtUtc, locale) : `${ev.dateLocal} (${ev.tz})`;
  const kindKey = `kind_${ev.kind}` as CopyKey;
  const relKey = `rel_${impact.relation}` as CopyKey;
  const holdingsUnavailable = !item.impact.holdings.length;
  const enabled = ACTIONS.filter((a) => impact.actions.includes(a));
  const primary = primaryActionOf(enabled, tasksReady && impact.tasks.length > 0);
  const secondary = enabled.filter((a) => a !== primary);
  const hiddenCount = ACTIONS.length - enabled.length;
  const naReason = !tasksReady ? c("na_tasks_not_ready") : impact.tasks.length === 0 ? c("na_no_task") : c("na_generic");
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
            {ev.revision > 0 ? ` · ${c("revision")} ${ev.revision}` : ""}
            {ev.revisedFrom ? ` · ${c("revised_from")} ${ev.revisedFrom.dateLocal}` : ""}
          </p>
          <p className="text-[11px] text-fg-3">{c("source")} {SOURCE_NAME[ev.source] ?? ev.source} · {c("first_known")} {formatTime(ev.firstKnownAt, locale)}</p>
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
                const meta = assetByKey(assets, a);
                return (
                  <li key={a} className="text-xs">
                    <span className="font-semibold">{meta?.displaySymbol ?? a}</span>
                    {h ? <span className="ml-2 text-fg-2">· {c("your_holding")} {meta ? formatAmount(h.balanceRaw, meta.tokenDecimals, meta.displaySymbol) : h.balanceRaw}</span> : holdingsUnavailable ? <span className="ml-2 text-fg-3">· {c("no_holding_data")}</span> : null}
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
                    <Link className="underline" href={`/agent/tasks/${t.taskId}`}>{c("open_task")}</Link> <Pill tone={EFFECT_TONE[t.effect] ?? "neutral"}>{c(`effect_${t.effect}` as CopyKey)}</Pill>
                    {rules.map((r) => (
                      <div key={r.ruleLabel} className="text-[11px] text-fg-2">
                        {r.ruleLabel}
                        {r.window ? ` · ${c("window")} ${formatTime(r.window.startUtc, locale)} → ${formatTime(r.window.endUtc, locale)}` : r.needsChoice ? ` · ${c("needs_choice")}` : ""}
                        {r.nextCheckAt ? ` · ${c("next_check")} ${formatTime(r.nextCheckAt, locale)}` : ""}
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
                {reasonText6(b.code, locale)}
                {b.nextCheckAt ? <span className="text-fg-2"> · {c("next_check")} {formatTime(b.nextCheckAt, locale)}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="space-y-2 border-t border-line pt-3">
        {tasksReady && impact.tasks.length > 1 && (
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
        <div className="flex flex-wrap items-center gap-2">
          {primary && <button type="button" className="btn h-8 px-3 text-xs" disabled={busy !== null} onClick={() => void run(primary)}>{busy === primary ? "…" : c(`action_${primary}` as CopyKey)}</button>}
          {secondary.length > 0 && <button type="button" className="btn-ghost h-8 px-3 text-xs" aria-expanded={more} onClick={() => setMore((v) => !v)}>{more ? c("less") : `${c("more")} (${secondary.length})`}</button>}
          {!primary && <span className="text-xs text-fg-3">{naReason}</span>}
        </div>
        {more && secondary.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {secondary.map((a) => <button key={a} type="button" className="btn-ghost h-8 px-3 text-xs" disabled={busy !== null} onClick={() => void run(a)}>{busy === a ? "…" : c(`action_${a}` as CopyKey)}</button>)}
          </div>
        )}
        {hiddenCount > 0 && primary && <p className="text-[11px] text-fg-3">{zh ? `另有 ${hiddenCount} 个动作不适用于此事件：${naReason}` : `${hiddenCount} other action(s) do not apply here: ${naReason}`}</p>}
        <p className="text-[11px] text-fg-3">{c("no_exec")}</p>
        {result && <ActionOutcome result={result} event={ev} onWholeDay={() => void run("wait_by_rule", { wholeDayIfDayPrecision: true })} onIgnore={() => void run("keep_plan")} />}
      </div>
      <details><summary className="cursor-pointer text-[11px] text-fg-3">{c("dev_view")}</summary><p className="mono mt-1 break-all text-[11px] text-fg-3">{ev.id} · {ev.source} · {ev.firstKnownAt}{impact.tasks.length ? ` · ${impact.tasks.map((t) => t.taskId).join(", ")}` : ""}</p></details>
    </article>
  );
}

/** diff 一行：新增 / 移除 / 改为 */
function diffSentence(d: { itemType: string; before: unknown; after: unknown }, locale: "en" | "zh"): string {
  const zh = locale === "zh";
  const txt = (v: unknown) => (v && typeof v === "object" && "type" in (v as object) ? conditionText(v as Condition, locale) : JSON.stringify(v));
  if (d.before === null || d.before === undefined) return zh ? `新增条件：${txt(d.after)}` : `Add: ${txt(d.after)}`;
  if (d.after === null || d.after === undefined) return zh ? `移除条件：${txt(d.before)}` : `Remove: ${txt(d.before)}`;
  return zh ? `改为：${txt(d.after)}（原来：${txt(d.before)}）` : `Change to: ${txt(d.after)} (was: ${txt(d.before)})`;
}

function ActionOutcome({ result, event, onWholeDay, onIgnore }: { result: { action: ImpactAction; status: number; r: ActionResult | null; error: string | null }; event: EventDeskItem["event"]; onWholeDay: () => void; onIgnore: () => void }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const c = copy(locale);
  const [open, setOpen] = useState(false);
  const r = result.r;
  if (!r || (result.error && !r.effect)) {
    return <div className="rounded-md bg-bad/12 p-2 text-xs text-bad">{result.status === 0 || result.status === 502 ? c("unreachable") : `${c(`action_${result.action}` as CopyKey)}: ${result.error ?? `HTTP ${result.status}`}`}</div>;
  }
  const tone = r.effect === "not_ready" ? "bg-warn/12 text-warn" : r.effect === "invalid" ? "bg-bad/12 text-bad" : r.effect === "needs_choice" ? "bg-warn/12 text-fg-1" : "bg-surface-2 text-fg-1";
  const effKey = `eff_${r.effect}` as CopyKey;
  const estimated = event.datePrecision !== "exact" || event.status === "estimated";
  return (
    <div className={`rounded-md p-3 text-sm ${tone}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Pill tone={r.effect === "not_ready" ? "warn" : r.effect === "invalid" ? "bad" : "ok"}>{c(effKey) ?? r.effect}</Pill>
        {r.mode === "SIMULATION" && <Pill tone="info">{c("sim_only")}</Pill>}
      </div>
      <p className="mt-1">{r.message[locale]}</p>
      {r.effect === "needs_choice" && (
        <div className="mt-2 flex flex-wrap gap-2">
          <button type="button" className="btn h-8 px-3 text-xs" onClick={onWholeDay}>{c("whole_day")}</button>
          <button type="button" className="btn-ghost h-8 px-3 text-xs" onClick={onIgnore}>{c("ignore_event")}</button>
        </div>
      )}
      {r.effect === "evidence" && (
        <div className="mt-2 text-xs">
          {!r.evidence || r.evidence.length === 0 ? <p className="text-fg-2">{estimated ? c("evidence_none_estimated") : c("evidence_none")}</p> : (
            <>
              <button type="button" className="btn-ghost h-7 px-2 text-xs" onClick={() => setOpen((o) => !o)}>{r.evidence.length} {c("evidence_n")} · {open ? c("hide") : c("show_more")}</button>
              {open && <Json value={r.evidence} />}
            </>
          )}
        </div>
      )}
      {r.effect === "preview" && r.preview && (
        <div className="mt-2 text-xs">
          {(r.preview.diff ?? []).length > 0 ? <ul className="space-y-0.5">{r.preview.diff.map((d, i) => <li key={i}>· {diffSentence(d, locale)}</li>)}</ul> : <p className="text-fg-2">{zh ? "新计划与现计划没有差异。" : "The new plan does not differ from the current one."}</p>}
          {(r.preview.proposedConditions ?? []).length > 0 && <details className="mt-1"><summary className="cursor-pointer text-fg-3">{zh ? `新计划的全部 ${r.preview.proposedConditions.length} 条条件` : `All ${r.preview.proposedConditions.length} condition(s) of the new plan`}</summary><ul className="mt-1 space-y-0.5">{r.preview.proposedConditions.map((x, i) => <li key={i}>· {conditionText(x, locale)}</li>)}</ul></details>}
          <p className="mt-1 text-fg-3">{c("preview_no_auth")}</p>
        </div>
      )}
      {(r.effect === "draft" || r.effect === "created" || r.effect === "attached") && (
        <div className="mt-2 text-xs">
          {r.taskId && <Link className="underline" href={`/agent/tasks/${r.taskId}`}>{c("open_task")} →</Link>}
          {r.draft !== undefined && <><button type="button" className="btn-ghost ml-2 h-7 px-2 text-xs" onClick={() => setOpen((o) => !o)}>{open ? c("hide") : c("dev_view")}</button>{open && <Json value={r.draft} />}</>}
        </div>
      )}
      {r.blockers && r.blockers.length > 0 && r.effect !== "needs_choice" && (
        <ul className="mt-2 space-y-1 text-xs">
          {r.blockers.map((b, i) => (
            <li key={`${b.code}-${i}`}>· {reasonText6(b.code, locale)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
