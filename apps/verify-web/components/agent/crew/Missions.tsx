"use client";
/** Missions：由服务端从事件日历 × 资产覆盖生成；事件源未接上 → 标注日期的回放任务（标 REPLAY，不冒充实时）。 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowRight } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { missions as missionsApi, notReady, type MissionView } from "@/lib/api-v2";
import { Card, Pill } from "@/components/ui";
import { ModeTag, NotReady } from "../shared";

export function Missions({ assetKey }: { assetKey?: string }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const [state, setState] = useState<{ status: "loading" } | { status: "not_ready"; http: number } | { status: "ok"; coverage: "ok" | "unavailable"; items: MissionView[] }>({ status: "loading" });
  useEffect(() => {
    let alive = true;
    missionsApi.list(assetKey ? { assetKey } : {}).then((r) => {
      if (!alive) return;
      if (r.status === 200) setState({ status: "ok", coverage: r.data.eventsCoverage, items: r.data.missions });
      else setState({ status: "not_ready", http: r.status });
    }).catch(() => alive && setState({ status: "not_ready", http: 0 }));
    return () => { alive = false; };
  }, [assetKey]);
  return (
    <Card title={zh ? "今晚的任务" : "Tonight's missions"} right={state.status === "ok" ? <Pill tone={state.coverage === "ok" ? "ok" : "warn"}>{state.coverage === "ok" ? (zh ? "事件日历已接" : "calendar live") : (zh ? "事件日历未接 → 回放" : "no calendar → replay")}</Pill> : null}>
      {state.status === "loading" && <p className="ag-note">{zh ? "加载中…" : "Loading…"}</p>}
      {state.status === "not_ready" && (notReady({ status: state.http, data: null }) ? <NotReady what="/v1/missions" status={state.http} /> : <p className="ag-note">HTTP {state.http}</p>)}
      {state.status === "ok" && (
        <div className="ag-grid-2">
          {state.items.map((m) => (
            <article key={m.id} className="ag-mission">
              <div className="ag-mission-meta"><ModeTag mode={m.mode} /><span className="mono text-[11px] text-fg-3">{m.dateLabel}</span>{m.eventStatus && <Pill tone={m.eventStatus === "confirmed" ? "ok" : "warn"}>{m.eventStatus}</Pill>}</div>
              <h3>{m.title[locale]}</h3>
              <p>{m.why[locale]}</p>
              <p className="mono text-[11px] text-fg-3">{m.draft.playbookId} · {m.draft.conditions.items.map((c) => c.type).join(" · ")}</p>
              <Link href={m.href} className="btn-ghost h-8 self-start px-3 text-xs">{zh ? "用这个草案" : "Use this draft"}<ArrowRight size={14} aria-hidden="true" /></Link>
            </article>
          ))}
          {state.items.length === 0 && <p className="ag-note">{zh ? "没有可生成的任务：登记表里没有可执行资产。" : "No mission could be generated: no executable asset in the registry."}</p>}
        </div>
      )}
    </Card>
  );
}
