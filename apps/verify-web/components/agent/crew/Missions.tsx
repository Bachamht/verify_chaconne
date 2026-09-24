"use client";
/** Missions：由服务端从事件日历 × 资产覆盖生成；事件源未接上 → 标注日期的回放任务（标 REPLAY，不冒充实时）。 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { missions as missionsApi, notReady, type MissionView } from "@/lib/api-v2";
import { Card, Pill } from "@/components/ui";
import { LoadingState, ModeTag, NotReady } from "../shared";
import { stashDraft } from "../tasks/taskDraft";

/** 草案的去处：SIMULATION 草案 → 预填建任务表单（V-30）；对照类 → 实验页（V-26）；回放 → 实验页回放 */
export function missionHref(m: Pick<MissionView, "kind" | "mode" | "href" | "assetKey">): { href: string; handoff: boolean } {
  if (m.mode === "SIMULATION" && /entry=compare/.test(m.href)) return { href: `/agent/lab?asset=${encodeURIComponent(m.assetKey ?? "")}#compare`, handoff: false };
  if (m.mode === "SIMULATION") return { href: "/agent?entry=buy&draft=1", handoff: true };
  return { href: m.href, handoff: false };
}

export function Missions({ assetKey, eventsKnown }: { assetKey?: string; /** 首页已从 /v1/event-impacts 拿到的事件数；有事件时绝不说「日历未接」（V-30） */ eventsKnown?: number | null }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const router = useRouter();
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
    <Card title={zh ? "今晚的任务" : "Tonight's missions"} right={state.status === "ok" ? <Pill tone={state.coverage === "ok" ? "ok" : eventsKnown ? "neutral" : "warn"}>{state.coverage === "ok" ? (zh ? "事件日历已接" : "calendar live") : eventsKnown ? (zh ? "没有匹配今晚的事件 → 回放" : "no matching event tonight → replay") : (zh ? "事件日历暂不可用 → 回放" : "calendar unavailable → replay")}</Pill> : null}>
      {state.status === "loading" && <LoadingState />}
      {state.status === "not_ready" && (notReady({ status: state.http, data: null }) ? <NotReady what="/v1/missions" status={state.http} /> : <p className="ag-note">HTTP {state.http}</p>)}
      {state.status === "ok" && (
        <div className="ag-grid-2">
          {state.items.map((m) => (
            <article key={m.id} className="ag-mission">
              <div className="ag-mission-meta"><ModeTag mode={m.mode} /><span className="mono text-[11px] text-fg-3">{m.dateLabel}</span>{m.eventStatus && <Pill tone={m.eventStatus === "confirmed" ? "ok" : "warn"}>{m.eventStatus}</Pill>}</div>
              <h3>{m.title[locale]}</h3>
              <p>{m.why[locale]}</p>
              <p className="mono text-[11px] text-fg-3">{m.draft.playbookId} · {m.draft.conditions.items.map((c) => c.type).join(" · ")}</p>
              {(() => { const to = missionHref(m); return to.handoff
                ? <button type="button" className="btn-ghost h-8 self-start px-3 text-xs" onClick={() => { stashDraft(m.draft); router.push(to.href); }}>{zh ? "用这个草案建任务" : "Create a task from this draft"}<ArrowRight size={14} aria-hidden="true" /></button>
                : <Link href={to.href} className="btn-ghost h-8 self-start px-3 text-xs">{zh ? "用这个草案" : "Use this draft"}<ArrowRight size={14} aria-hidden="true" /></Link>; })()}
            </article>
          ))}
          {state.items.length === 0 && <p className="ag-note">{zh ? "没有可生成的任务：登记表里没有可执行资产。" : "No mission could be generated: no executable asset in the registry."}</p>}
        </div>
      )}
    </Card>
  );
}
