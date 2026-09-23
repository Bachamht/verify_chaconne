"use client";
/** /agent/events（Lane D · C6）：地址 + 时间范围 → 影响清单（相关优先）→ 事件卡 → 覆盖与公司行动。数据取不到显示不可用，不用回放伪装。 */
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useI18n } from "@/lib/i18n";
import { useAccount } from "@/lib/useAccount";
import { fmtLocal, tzLabel } from "@/lib/format";
import { Card, EmptyState, Pill } from "@/components/ui";
import { copy, reasonText6, type CopyKey } from "./copy";
import { eventDesk, type ImpactsResponse } from "./api";
import { EventCard } from "./EventCard";

const HORIZONS = [24, 48, 72, 168, 720];
const isAddr = (s: string) => /^0x[0-9a-fA-F]{40}$/.test(s);

export function EventDesk() {
  const { locale } = useI18n();
  const c = copy(locale);
  const sp = useSearchParams();
  const account = useAccount();
  const [owner, setOwner] = useState(sp.get("owner") ?? "");
  const [horizon, setHorizon] = useState(Number(sp.get("horizonHours") ?? 48) || 48);
  const [state, setState] = useState<{ phase: "idle" | "loading" | "ok" | "unreachable" | "disabled" | "error"; data: ImpactsResponse | null; error?: string }>({ phase: "idle", data: null });
  const highlight = sp.get("event");
  useEffect(() => {
    if (account && !owner) setOwner(account);
  }, [account, owner]);

  const load = useCallback(async () => {
    if (!isAddr(owner)) return;
    setState((s) => ({ ...s, phase: "loading" }));
    const r = await eventDesk.impacts(owner.toLowerCase(), horizon);
    if (r.status === 200 && r.data) setState({ phase: "ok", data: r.data });
    else if (r.status === 404) setState({ phase: "disabled", data: null });
    else if (r.status === 0 || r.status === 502 || r.status === 503) setState({ phase: "unreachable", data: null });
    else setState({ phase: "error", data: null, error: r.error ?? `HTTP ${r.status}` });
  }, [owner, horizon]);
  useEffect(() => {
    void load();
  }, [load]);

  const d = state.data;
  const related = d?.items.filter((i) => i.relevance !== "universe") ?? [];
  const universe = d?.items.filter((i) => i.relevance === "universe") ?? [];
  const tasksReady = d?.tasks.status === "ok";

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold">{c("title")}</h1>
        <p className="mt-1 text-sm text-fg-2">{c("subtitle")}</p>
      </div>
      <Card>
        <div className="grid gap-3 md:grid-cols-[1fr_auto_auto] md:items-end">
          <label className="text-sm">
            <span className="text-xs text-fg-2">{c("owner")}</span>
            <input className="field mono mt-1" value={owner} placeholder={c("owner_ph")} onChange={(e) => setOwner(e.target.value.trim())} />
          </label>
          <label className="text-sm">
            <span className="text-xs text-fg-2">{c("horizon")}</span>
            <select className="field mt-1" value={horizon} onChange={(e) => setHorizon(Number(e.target.value))}>
              {HORIZONS.map((h) => (
                <option key={h} value={h}>{h} {c("hours")}</option>
              ))}
            </select>
          </label>
          <button type="button" className="btn" disabled={!isAddr(owner) || state.phase === "loading"} onClick={() => void load()}>{state.phase === "loading" ? c("loading") : c("refresh")}</button>
        </div>
        {d && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-fg-2">
            <span>{c("holdings")}:</span>
            <Pill tone={d.holdings.status === "ok" ? "ok" : "warn"}>{d.holdings.status === "ok" ? `${d.holdings.count}${d.holdings.asOf ? ` · ${c("as_of")} ${fmtLocal(d.holdings.asOf, locale)}` : ""}` : `${c("unavailable")}${d.holdings.note ? ` · ${d.holdings.note}` : ""}`}</Pill>
            <span>{c("tasks")}:</span>
            <Pill tone={d.tasks.status === "ok" ? "ok" : "warn"}>{d.tasks.status === "ok" ? String(d.tasks.count) : `${c("not_ready")}${d.tasks.note ? ` · ${d.tasks.note}` : ""}`}</Pill>
            <span className="ml-auto">{c("generated")} {fmtLocal(d.generatedAt, locale)} {tzLabel()}</span>
          </div>
        )}
      </Card>

      {!isAddr(owner) && <EmptyState compact title={c("need_owner")} />}
      {state.phase === "unreachable" && <EmptyState compact title={c("unreachable")} />}
      {state.phase === "disabled" && <EmptyState compact title={c("disabled")} />}
      {state.phase === "error" && <EmptyState compact title={state.error ?? "error"} />}

      {d && (
        <>
          <section className="space-y-3">
            <h2 className="text-lg font-semibold">{c("related")} <span className="mono text-sm text-fg-3">{related.length}</span></h2>
            {related.length === 0 ? <EmptyState compact title={c("empty")} /> : related.map((it) => <EventCard key={it.event.id} item={it} owner={owner.toLowerCase()} highlighted={highlight === it.event.id} tasksReady={tasksReady} />)}
          </section>
          {universe.length > 0 && (
            <section className="space-y-3">
              <h2 className="text-lg font-semibold">{c("universe")} <span className="mono text-sm text-fg-3">{universe.length}</span></h2>
              {universe.map((it) => <EventCard key={it.event.id} item={it} owner={owner.toLowerCase()} highlighted={highlight === it.event.id} tasksReady={tasksReady} />)}
            </section>
          )}
          <Card title={c("coverage_h")}>
            <p className="text-sm text-fg-2">{c("coverage_p")}</p>
            <ul className="mt-3 grid gap-1 text-xs sm:grid-cols-2 lg:grid-cols-3">
              {d.coverage.map((a) => (
                <li key={a.assetKey} className="flex flex-wrap items-center gap-2 border-b border-line py-1">
                  <span className="mono w-16">{a.displaySymbol}</span>
                  <Pill tone={a.coverage === "covered" ? "ok" : a.coverage === "unknown" ? "warn" : "neutral"}>{c(`cov_${a.coverage}` as CopyKey)}</Pill>
                  {a.code && <span className="text-fg-3" title={reasonText6(a.code, locale)}>{a.code}</span>}
                  {a.lastProbedAt && <span className="ml-auto text-fg-3">{c("last_probed")} {fmtLocal(a.lastProbedAt, locale)}</span>}
                </li>
              ))}
            </ul>
            <div className="mt-4 text-sm">
              <div className="flex items-center gap-2"><span className="font-medium">{c("corp_actions")}</span> <Pill tone="neutral">{d.corporateActions.status}</Pill></div>
              <p className="mt-1 text-xs text-fg-2">{c("corp_not_connected")}</p>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
