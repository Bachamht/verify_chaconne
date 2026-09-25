"use client";
/**
 * /agent 首页（上游 §5）：以任务为中心，不堆宏观仪表盘。
 * 顶部四入口 → 引导表单；新用户第一分钟；Crew（只复述真实响应）；今晚的任务；自然语言框（仅当有 Agent）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeftRight, ArrowUpRight, CalendarSearch, HelpCircle, ShoppingCart, Sparkles } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { marketContext, type CreateTaskBody } from "@/lib/api-v2";
import { assetByKey, loadAssets, type AssetsLoad } from "@/lib/assets";
import { useAccount } from "@/lib/useAccount";
import { agentTaskHistory } from "@/lib/history";
import { Card } from "@/components/ui";
import { RecentAgentTasks } from "../tasks/RecentAgentTasks";
import { Crew } from "../crew/Crew";
import { Missions } from "../crew/Missions";
import { nextUpcomingEvent } from "../crew/nextEvent";
import { eventDesk } from "../events/api";
import { presetFromDraft, takeDraft, type DraftHandoff, type TaskDraft } from "../tasks/taskDraft";
import { ENTRIES, type EntryId } from "./entries";
import { EntryPanel, labCompareHref, labWaitHref } from "./EntryForms";
import { FirstMinute } from "./FirstMinute";
import { NlBox } from "./NlBox";

const ICONS = { buy: ShoppingCart, impact: CalendarSearch, wait: HelpCircle, compare: ArrowLeftRight } as const;

export function AgentHome() {
  const { t, locale } = useI18n();
  const zh = locale === "zh";
  const sp = useSearchParams();
  const router = useRouter();
  const account = useAccount();
  const [assets, setAssets] = useState<AssetsLoad>({ assets: [], source: "none", evidenceMode: null });
  const [entry, setEntry] = useState<EntryId | null>((sp.get("entry") as EntryId | null) && ENTRIES.some((e) => e.id === sp.get("entry")) ? (sp.get("entry") as EntryId) : null);
  const [crewData, setCrewData] = useState<Record<string, unknown>>({});
  // 新用户优先（VERIFY-UX-REVIEW P1）：没连钱包也没有本机任务时，先给一个能直接跑的示例入口；四个功能入口保留在其后
  const [localTasks, setLocalTasks] = useState<number | null>(null);
  useEffect(() => {
    const read = () => setLocalTasks(agentTaskHistory().length);
    read();
    window.addEventListener("verify:history", read);
    return () => window.removeEventListener("verify:history", read);
  }, []);
  const newcomer = !account && localTasks === 0;
  // 草稿来源三选一：一句话编译（NlBox）> 会话交接（Missions「用这个草案」）> 查询串（playbook / asset / steps / inputAssetKey / perStepAmountRaw / mode）
  const [draft, setDraft] = useState<DraftHandoff | null>(null);
  useEffect(() => {
    if (sp.get("draft") === "1") {
      const d = takeDraft();
      if (d) setDraft(d);
    }
  }, [sp]);
  const preset = useMemo<Partial<TaskDraft> | undefined>(() => {
    const decimalsOf = (k: string) => assetByKey(assets.assets, k)?.tokenDecimals ?? null;
    const fromQuery: DraftHandoff = { playbookId: sp.get("playbook") ?? undefined, mode: sp.get("mode") ?? undefined, params: { outputAssetKey: sp.get("asset") ?? undefined, inputAssetKey: sp.get("inputAssetKey") ?? undefined, steps: sp.get("steps") ? Number(sp.get("steps")) : undefined, perStepAmountRaw: sp.get("perStepAmountRaw") ?? undefined } };
    const q = presetFromDraft(fromQuery, decimalsOf);
    const d = draft ? presetFromDraft(draft, decimalsOf) : {};
    const merged = { ...q, ...d };
    return Object.keys(merged).length ? merged : undefined;
  }, [sp, draft, assets]);
  const taskId = sp.get("task") ?? undefined;
  // V-26 / V-33：对照与等待诊断只保留实验页一套实现；旧链接 /agent?entry=compare|wait&task=… 直接转过去
  useEffect(() => {
    if (sp.get("entry") === "compare") router.replace(labCompareHref(sp.get("task"), sp.get("asset")));
    else if (sp.get("entry") === "wait" && sp.get("task")) router.replace(labWaitHref(sp.get("task")));
  }, [sp, router]);

  const reloadAssets = useCallback(() => { void loadAssets({ force: true }).then(setAssets); }, []);
  useEffect(() => {
    void loadAssets().then(setAssets);
  }, []);
  // Crew 数据：真实调用结果（未部署的端点不写入 → 角色显示「今晚没动作」）。
  // V-30：事件数 / 相关数 / 「最近一个」都从同一份 /v1/event-impacts 派生；「最近一个」只取未来且未取消的；没连钱包时才退回上下文日历
  const [eventsKnown, setEventsKnown] = useState<number | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      const data: Record<string, unknown> = {};
      const ctx = await marketContext.get(account ? { owner: account } : {}).catch(() => null);
      if (ctx && ctx.status === 200) data["context"] = ctx.data;
      let known: number | null = null;
      if (account) {
        const imp = await eventDesk.impacts(account, 48).catch(() => null);
        if (imp && imp.status === 200 && imp.data) {
          const items = Array.isArray(imp.data.items) ? imp.data.items : [];
          const events = items.map((i) => i.event);
          data["events"] = events;
          data["impacts"] = items.filter((i) => i.relevance !== "universe").map((i) => i.impact);
          known = events.length;
          const next = nextUpcomingEvent(events, Date.now());
          if (next) data["nextEvent"] = next;
        }
      }
      if (!("nextEvent" in data) && ctx && ctx.status === 200) {
        const next = nextUpcomingEvent(ctx.data.events ?? [], Date.now());
        if (next) data["nextEvent"] = next;
      }
      if (alive) { setCrewData(data); setEventsKnown(known); }
    })();
    return () => { alive = false; };
  }, [account]);

  return (
    <>
      <header>
        <h1 className="ag-h1">{zh ? "把今晚的事交给你的 Agent" : "Hand tonight to your agent"}</h1>
        <p className="ag-lead">{zh ? "它先读市场上下文和事件日历，按你定的条件等待或行动；每一步先核验、签证书，再由合约按你签过的边界执行。单笔核验、规划、试玩与验证器在页头「工具」里。" : "It reads the market context and the event calendar, waits or acts by the conditions you set; every step is verified and certified before a contract executes it inside the boundaries you signed. Single verification, planning, play and the verifier live under Tools in the header."}</p>
      </header>
      {newcomer && (
        <Card className="ag-start-here" title={zh ? "第一次来？先免费模拟一个任务" : "First time here? Simulate a task for free"} right={<Sparkles size={18} aria-hidden="true" className="text-brand-300" />}>
          <p className="ag-note">{zh ? "不需要钱包，也不需要自备 Agent。选一个模板、设一个模拟预算，看看它现在会行动还是等待；满意后再决定是否授权真实交易。下面的四个入口和表单是完整工作区，随时可用。" : "No wallet or agent of your own needed. Pick a template and a simulation budget to see whether it would act or wait now; decide about real trades afterwards. The four entries and forms below are the full workspace and stay available."}</p>
          <div className="ag-actions mt-3"><Link className="btn" href="/start">{zh ? "免费体验一个任务" : "Try a task for free"}<ArrowUpRight size={15} aria-hidden="true" /></Link><Link className="btn-ghost" href="/agent/tasks">{zh ? "我已经有任务" : "I already have tasks"}</Link></div>
        </Card>
      )}
      {!account && localTasks !== null && localTasks > 0 && <RecentAgentTasks />}
      <div className="ag-entries" role="tablist" aria-label={zh ? "四个入口" : "Four entries"}>
        {ENTRIES.map((e) => {
          const Icon = ICONS[e.id];
          return <button key={e.id} type="button" role="tab" className="ag-entry" aria-pressed={entry === e.id} aria-selected={entry === e.id} onClick={() => setEntry(entry === e.id ? null : e.id)}><Icon size={20} aria-hidden="true" /><strong>{t(e.key)}</strong><span>{e.blurb[locale]}</span></button>;
        })}
      </div>
      {entry && <Card title={t(ENTRIES.find((e) => e.id === entry)!.key)}><EntryPanel entry={entry} assets={assets.assets} assetsSource={assets.source} onRetryAssets={reloadAssets} preset={preset} taskId={taskId} /></Card>}
      <FirstMinute assets={assets} onRetryAssets={reloadAssets} />
      <NlBox onDraft={(d: Partial<CreateTaskBody>) => { setDraft({ playbookId: d.playbookId, mode: d.mode, params: d.params, conditions: d.conditions }); setEntry("buy"); }} />
      <Card title={zh ? "今晚的 Crew" : "Tonight's crew"} right={<span className="ag-note">{zh ? "台词只复述真实响应字段" : "lines quote real response fields only"}</span>}><Crew data={crewData} /></Card>
      <Missions eventsKnown={eventsKnown} />
    </>
  );
}
