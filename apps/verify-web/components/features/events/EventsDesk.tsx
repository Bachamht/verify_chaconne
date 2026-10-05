"use client";
/**
 * /agent/events v8（方案 §5.7）：回答「接下来哪些事件会影响我」与「Agent 会怎么做」。
 * 工具条（范围 / 只看相关 / 资产，全部写 URL）→ 数据源行（更新于 · 心跳）→ 按天分组的事件列表 → 右侧详情抽屉（?event=）。
 * 先出日历（约 0.2 s），命中在浏览器里只为未结束任务算；服务端整份影响清单后台补上，不挡首屏。
 * 不做：持仓数（事件接口给的持仓与钱包不一致，不可信就不显示）、原始规则串、时间轴图。
 */
import dynamic from "next/dynamic";
import { LoaderCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/kit/FourStates";
import { PageHeader } from "@/components/kit/PageHeader";
import { Panel } from "@/components/kit/Panel";
import { NotReturned } from "@/components/kit/NotReturned";
import { Timestamp } from "@/components/kit/Timestamp";
import { useI18n } from "@/lib/i18n";
import { useAccount } from "@/lib/useAccount";
import { useQueryState } from "@/lib/useQueryState";
import { requestIdOf } from "@/lib/useResource";
import { copy } from "./copy";
import { EventList, EventListSkeleton } from "./EventList";
import { EventsDeskFallback } from "./EventsDeskFallback";
import { EventsToolbar, RANGES } from "./EventsToolbar";
import { heartbeatOf } from "./eventText";
import { useEventDesk } from "./useEventDesk";
import { useQueryPatch } from "@/lib/useQueryState";

// 抽屉（Sheet / Tabs / 菜单 / 覆盖表）点开才加载，不进首屏包
const EventSheet = dynamic(() => import("./EventSheet").then((m) => m.EventSheet), { ssr: false });

export function EventsDesk() {
  const { locale } = useI18n();
  const c = copy(locale);
  const account = useAccount();
  if (!account) return <EventsDeskFallback />;
  return (
    <div className="flex w-full min-w-0 flex-col">
      <PageHeader title={c("title")} description={c("subtitle")} />
      <DeskBody owner={account.toLowerCase()} />
    </div>
  );
}

function DeskBody({ owner }: { owner: string }) {
  const { locale } = useI18n();
  const c = copy(locale);
  const [rangeQ, setRange] = useQueryState("range", "48");
  const hours = (RANGES as readonly number[]).includes(Number(rangeQ)) ? Number(rangeQ) : 48;
  const [relQ, setRel] = useQueryState("rel", "");
  const [asset, setAsset] = useQueryState("asset", "");
  const [eventId, setEventId] = useQueryState("event", "");
  const [tab, setTab] = useQueryState("tab", "");
  const patch = useQueryPatch();
  const desk = useEventDesk(owner, hours, locale);
  const relevant = relQ === "1";

  const assetKey = asset ? desk.assetList.find((a) => a.displaySymbol === asset)?.assetKey ?? null : null;
  const visible = desk.rows.filter((r) => {
    if (relevant && !(r.hits && r.hits.length > 0)) return false;
    if (asset && !(r.assets.some((a) => a.displaySymbol === asset) || (assetKey && r.hits?.some((h) => h.task.assetKeys.includes(assetKey))))) return false;
    return true;
  });
  const assetOptions = [...new Set(desk.assetList.filter((a) => a.role === "stock_output" && a.executionAllowed).map((a) => a.displaySymbol))].sort();
  const heartbeat = heartbeatOf(null, desk.allEvents);
  const cal = desk.calendar;

  let body: React.ReactNode;
  if (cal.state === "loading" || cal.state === "idle" || (relevant && desk.tasks.state === "loading")) body = <LoadingBlock shape={<EventListSkeleton />} onRetry={cal.reload} />;
  else if (cal.state === "error") body = <ErrorState title={c("load_error")} status={cal.status ?? 0} requestId={requestIdOf(cal.errorBody)} onRetry={cal.reload} />;
  // 只看相关靠任务命中：任务没读到时不能说「没有相关事件」
  else if (relevant && desk.tasks.state === "error") body = <ErrorState title={c("tasks_error")} status={desk.tasks.status ?? 0} requestId={requestIdOf(desk.tasks.errorBody)} onRetry={desk.tasks.reload} />;
  else if (visible.length === 0) {
    const filtered = relevant || Boolean(asset);
    body = (
      <EmptyState
        title={filtered ? c("empty_rel_title") : c("empty_title")}
        description={filtered ? c("empty_rel_desc") : c("empty_desc")}
        action={filtered ? <Button size="sm" variant="outline" onClick={() => patch({ rel: null, asset: null })}>{c("show_all")}</Button> : hours < 72 ? <Button size="sm" variant="outline" onClick={() => setRange("72")}>{c("widen")}</Button> : undefined}
      />
    );
  } else body = <EventList rows={visible} nowMs={desk.nowMs} selectedId={eventId} onOpen={(id) => setEventId(id)} tasksFailed={desk.tasks.state === "error"} />;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <EventsToolbar hours={hours} onHours={(h) => setRange(String(h))} relevant={relevant} onRelevant={(v) => setRel(v ? "1" : null)} asset={asset} onAsset={(s) => setAsset(s || null)} assetOptions={assetOptions} />
      <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-fg-3" aria-live="polite">
        <span className="text-fg-2">{c("source_line")}</span>
        <span>·</span>
        <span>{c("updated")} {cal.updatedAt ? <Timestamp at={cal.updatedAt} mode="rel" /> : <NotReturned />}</span>
        <span>·</span>
        <span>{c("heartbeat")} {heartbeat ? <Timestamp at={heartbeat} mode="rel" /> : <NotReturned />}</span>
        {desk.impacts.state === "loading" ? <><span>·</span><span className="inline-flex items-center gap-1"><LoaderCircle className="size-3 animate-spin" aria-hidden="true" />{c("impact_checking")}</span></> : null}
        {desk.impacts.state === "ok" && desk.impacts.updatedAt ? <><span>·</span><span>{c("impact_checked")} <Timestamp at={desk.impacts.updatedAt} mode="rel" /></span></> : null}
      </p>
      <Panel aria-label={c("title")}>{body}</Panel>
      {eventId ? <EventSheet desk={desk} owner={owner} eventId={eventId} onClose={() => patch({ event: null, tab: null })} tab={tab} onTab={(t) => setTab(t || null)} /> : null}
    </div>
  );
}
