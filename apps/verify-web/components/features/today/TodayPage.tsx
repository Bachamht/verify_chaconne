"use client";
/**
 * /agent「今天」（v8，方案 §5.3）：现在几个任务在跑 / 需要我处理什么 / 下一个影响我的事件 / 资金够不够。
 * 无 hero、无表单、无 Crew 空壳；创建入口统一去 /agent/new。没有任务时整页是一个带吉祥物的空状态。
 * 装载顺序（loadToday.ts）：事件先发 → 任务板 → 事件结束后再拉最近 3 个任务的活动流（Agent 刚说 / 今日成交）。
 */
import Link from "next/link";
import { useMemo } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PageHeader } from "@/components/kit/PageHeader";
import { Panel } from "@/components/kit/Panel";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/kit/FourStates";
import { Mascot } from "@/components/kit/Mascot";
import { KpiRow } from "@/components/kit/StatTile";
import { useNow } from "@/components/kit/useNow";
import { eventDesk, type ImpactsResponse } from "@/components/agent/events/api";
import { useI18n } from "@/lib/i18n";
import { useAccount } from "@/lib/useAccount";
import { requestIdOf, useResource } from "@/lib/useResource";
import { mergeTaskRows } from "../tasks/model";
import { loadPulses, loadToday } from "./loadToday";
import { agentSayings, needsList, pickPulseTasks } from "./model";
import { TodayKpis } from "./TodayKpis";
import { NeedsPanel } from "./NeedsPanel";
import { TodayTasksPanel } from "./TodayTasksPanel";
import { EventsPanel } from "./EventsPanel";
import { SaysPanel } from "./SaysPanel";

export function TodayPage() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const account = useAccount();
  const now = useNow(60_000);
  const who = account?.toLowerCase() ?? null;
  // 事件请求先声明 = 先发出（effect 按声明顺序执行）
  const events = useResource(who ? `today-events:${who}` : null, () => eventDesk.impacts(who!, 168).then((r) => ({ status: r.status, data: r.data as ImpactsResponse })), { intervalMs: 5 * 60_000 });
  const today = useResource(who ? `today:${who}` : null, () => loadToday(who!), { intervalMs: 60_000 });

  const d = today.data;
  const rows = useMemo(() => (d ? mergeTaskRows({ ...d.board, locale }) : []), [d, locale]);
  // 选任务只用与语言无关的字段（分组、模式、更新时间）
  const pick = useMemo(() => (d ? pickPulseTasks(mergeTaskRows({ ...d.board, locale: "en" }), new Date(d.at)) : null), [d]);
  const eventsSettled = events.state !== "loading" && events.state !== "idle";
  const pulseKey = who && pick && eventsSettled ? `today-pulse:${who}:${pick.ids.join(",")}:${pick.coversToday ? 1 : 0}` : null;
  const pulse = useResource(pulseKey, () => loadPulses(pick!.ids, pick!.coversToday), { intervalMs: 60_000 });
  const pulses = pulse.data?.pulses ?? null;
  const needs = useMemo(() => needsList(rows, pulses ?? [], locale), [rows, pulses, locale]);
  const says = useMemo(() => (d && pulses ? agentSayings(pulses, rows, d.board.assets, locale) : []), [d, pulses, rows, locale]);
  const partial = pulse.state === "error" || Boolean(pulses?.some((p) => !p.ok)) || d?.board.partial === "list";
  const dateLabel = now ? new Intl.DateTimeFormat(zh ? "zh-CN" : "en-US", { month: "long", day: "numeric", weekday: "long" }).format(now) : null;
  const newTask = <Button asChild><Link href="/agent/new"><Plus aria-hidden="true" />{zh ? "新建任务" : "New task"}</Link></Button>;
  const header = <PageHeader className="ch-today-header" title={zh ? "今天" : "Today"} description={dateLabel ?? " "} actions={rows.length > 0 || today.state !== "ok" ? newTask : null} />;

  if (today.state === "loading" || today.state === "idle") {
    return (
      <div className="ch-today">
        {header}
        <LoadingBlock shape={<div className="flex flex-col gap-4"><KpiRow>{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-lg" />)}</KpiRow><Skeleton className="h-64 rounded-lg" /></div>} onRetry={today.reload} />
      </div>
    );
  }
  if (today.state === "error") {
    return <div className="ch-today">{header}<Panel><ErrorState status={today.status ?? undefined} requestId={requestIdOf(today.errorBody)} onRetry={today.reload} title={zh ? "今天的任务没有拿到" : "Could not load today's tasks"} /></Panel></div>;
  }
  if (rows.length === 0) {
    return (
      <div className="ch-today">
        {header}
        <Panel className="ch-today-empty">
          <EmptyState
            art={<Mascot alt={zh ? "Chaconne 小指挥家" : "Chaconne's conductor"} />}
            title={zh ? "还没有任务，先交代一件事给 Agent" : "No tasks yet. Hand the agent its first job"}
            description={zh ? "建议先建观察任务：Agent 只判断、不交易，看过它的判断再决定要不要真实运行。" : "Start with an observation task: the agent only evaluates and never trades. Review its calls before going live."}
            action={<Button asChild><Link href="/agent/new"><Plus aria-hidden="true" />{zh ? "新建任务" : "New task"}</Link></Button>}
          />
        </Panel>
      </div>
    );
  }
  return (
    <div className="ch-today">
      {header}
      <TodayKpis rows={rows} data={d!} pulse={pulse} needs={needs.length} partialNeeds={partial} />
      <div className="ch-today-layout">
        <div className="ch-today-main">
          <NeedsPanel items={needs} partial={partial} />
          <TodayTasksPanel rows={rows} />
        </div>
        <div className="ch-today-aside">
          <EventsPanel res={events} />
          <SaysPanel items={says} state={pulse.state} onRetry={pulse.reload} />
        </div>
      </div>
    </div>
  );
}
