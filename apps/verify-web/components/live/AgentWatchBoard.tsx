"use client";
/**
 * P6 公开值守看板（决赛现场观众用手机看）：GET /pub/tasks/:shareId/activity（服务端 5 s 缓存），5 s 轮询，页面隐藏即停。
 * 只显示类别与时间——不显示任何金额、数量、地址或自由文本：数据先经 normalizePublicActivity 白名单（只留 at + category），
 * 类别再经固定标签表翻译，认不出的类别显示「其它活动」，原始字符串永不上屏。
 */
import { useEffect, useRef, useState } from "react";
import { pubTaskActivity, type PublicActivityView } from "@/lib/api-v2";
import { formatTime } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { tv } from "@/lib/i18n.v7";
import { v7FixtureRequested } from "@/lib/v7";
import { fxPublicActivity } from "@/lib/v7fixtures";
import { ModeTag } from "@/components/agent/shared";
import { actorLabel, boardLabel, presenceLabel } from "@/components/features/public/boardLabels";
import "@/components/agent/v7.css";

/** 标签函数移到 features/public/boardLabels.ts（v8 看板共用）；这里 re-export 保持旧导入路径 */
export { actorLabel, boardLabel, presenceLabel };

export function AgentWatchBoard({ shareId }: { shareId: string }) {
  const { locale } = useI18n();
  const [fixture] = useState(() => typeof window !== "undefined" && v7FixtureRequested(window.location.search));
  const [view, setView] = useState<PublicActivityView | null>(fixture ? fxPublicActivity() : null);
  const [state, setState] = useState<"busy" | "ok" | "missing" | "offline">(fixture ? "ok" : "busy");
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    if (fixture) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stop = false;
    const tick = async () => {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") { timer = setTimeout(tick, 5000); return; }
      const r = await pubTaskActivity(shareId);
      if (!alive.current || stop) return;
      if (r.status === 200 && r.data) { setView(r.data); setState("ok"); }
      else if (r.status === 404) setState("missing");
      else setState((s) => (s === "ok" ? s : "offline"));
      timer = setTimeout(tick, 5000);
    };
    void tick();
    return () => { stop = true; if (timer) clearTimeout(timer); };
  }, [shareId, fixture]);

  const items = [...(view?.items ?? [])].sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 60);
  const now = presenceLabel(view?.presence, locale) ?? (items[0] ? boardLabel(items[0].category, locale) : null);
  return (
    <div className="v7-board" data-testid="watch-board">
      <header>
        <p className="ag-note mono">CHACONNE AGENT</p>
        <h1 className="ag-h1">{tv(locale, "pb_h")}</h1>
        <p className="ag-lead">{tv(locale, "pb_lead")}</p>
        <div className="ag-actions mt-2">{fixture && <ModeTag mode="FIXTURE" />}{view?.mode && <ModeTag mode={view.mode} />}<span className="ag-note">{tv(locale, "pb_updated")}</span></div>
      </header>
      {state === "missing" ? <p className="ag-warn">{tv(locale, "pb_not_found")}</p> : state === "offline" && !view ? <p className="ag-note">{tv(locale, "unreachable")}</p> : state === "busy" ? <p className="ag-note">{tv(locale, "loading")}</p> : (
        <>
          <div className="v7-board-now" aria-live="polite"><span className="ag-note">{tv(locale, "pb_now")}</span><strong>{now ?? "—"}</strong></div>
          {items.length === 0 ? <p className="ag-note">{tv(locale, "pb_empty")}</p> : (
            <ol>
              {items.map((it, i) => <li key={`${it.at}-${i}`}><time dateTime={it.at}>{formatTime(it.at, locale)}</time><span>{boardLabel(it.category, locale)}{actorLabel(it.actor, locale) ? <span className="ag-note"> · {actorLabel(it.actor, locale)}</span> : null}</span></li>)}
            </ol>
          )}
        </>
      )}
    </div>
  );
}
