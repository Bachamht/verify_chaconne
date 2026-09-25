"use client";
/**
 * /agent 首页（上游 §5）：以任务为中心，不堆宏观仪表盘。
 * 顶部四入口 → 引导表单；新用户第一分钟；Crew（只复述真实响应）；今晚的任务；自然语言框（仅当有 Agent）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ArrowLeftRight, ArrowUpRight, HelpCircle, ShoppingCart, Sparkles, Target } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { marketContext } from "@/lib/api-v2";
import { assetByKey, loadAssets, type AssetsLoad } from "@/lib/assets";
import { useAccount } from "@/lib/useAccount";
import { Card } from "@/components/ui";
import { Crew } from "../crew/Crew";
import { Missions } from "../crew/Missions";
import { nextUpcomingEvent } from "../crew/nextEvent";
import { eventDesk } from "../events/api";
import { presetFromDraft, takeDraft, type DraftHandoff, type TaskDraft } from "../tasks/taskDraft";
import { ENTRIES, type EntryId } from "./entries";
import { EntryPanel, labCompareHref, labWaitHref } from "./EntryForms";
import { MyAgentTasks } from "./MyAgentTasks";
import { FirstMinute } from "./FirstMinute";

const ICONS = { goal: Target, buy: ShoppingCart, wait: HelpCircle, compare: ArrowLeftRight } as const;

export function AgentHome() {
  const { t, locale } = useI18n();
  const zh = locale === "zh";
  const sp = useSearchParams();
  const router = useRouter();
  const account = useAccount();
  const [assets, setAssets] = useState<AssetsLoad>({ assets: [], source: "none", evidenceMode: null });
  const entry: EntryId | null = ENTRIES.some((e) => e.id === sp.get("entry")) ? (sp.get("entry") as EntryId) : null;
  // 入口切换写进 URL（push）：浏览器回退回到上一个视图，而不是跳出页面
  const setEntry = (next: EntryId | null) => { const q = new URLSearchParams(sp.toString()); if (next) q.set("entry", next); else q.delete("entry"); q.delete("draft"); const qs = q.toString(); router.push(`/agent${qs ? `?${qs}` : ""}`, { scroll: false }); };
  const [crewData, setCrewData] = useState<Record<string, unknown>>({});
  // 新用户优先（VERIFY-UX-REVIEW P1）：没连钱包时先给一个能直接跑的示例入口；四个功能入口保留在其后
  const newcomer = !account;
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
        <p className="ag-lead">{zh ? "你带着自己的 Agent 和策略来：给它一个目标和签过的范围，它用 Chaconne 的数据研究、决定何时买哪个买多少，每一笔先核验、签证书，再由合约按你签过的边界执行。固定自动化工具（定投、避开事件、价格观察）在第二个入口。" : "Bring your own agent and strategy: give it an objective and a signed scope, it researches with Chaconne's data and decides when, which asset and how much; every trade is verified and certified before a contract executes it inside the boundaries you signed. Fixed automation tools (DCA, event windows, price watch) are the second entry."}</p>
      </header>
      {newcomer && (
        <Card className="ag-start-here" title={zh ? "第一次来？先看示例，或免费模拟一个任务" : "First time here? Browse the examples, or simulate a task for free"} right={<Sparkles size={18} aria-hidden="true" className="text-brand-300" />}>
          <p className="ag-note">{zh ? "首页的目标委托与示例策略可以先浏览；建任务、看自己的任务和资金需要连接钱包。没有自己的 Agent 也可以用「更多」里的固定自动化工具先模拟。" : "The goal entry and example strategies are open to browse; creating tasks and seeing your own tasks and funds need a wallet. Without an agent of your own, the fixed automation tools under “More” can simulate first."}</p>
          <div className="ag-actions mt-3"><Link className="btn" href="/start">{zh ? "免费体验一个任务" : "Try a task for free"}<ArrowUpRight size={15} aria-hidden="true" /></Link><Link className="btn-ghost" href="/agent/tasks">{zh ? "我已经有任务" : "I already have tasks"}</Link></div>
        </Card>
      )}
      {/* 主入口：把目标交给 Agent（默认展开）；固定自动化 / 旧链接（entry=buy|wait|compare）仍可用 */}
      {(!entry || entry === "goal") && <Card title={t("ag_entry_goal")}><EntryPanel entry="goal" assets={assets.assets} assetsSource={assets.source} onRetryAssets={reloadAssets} /></Card>}
      {entry && entry !== "goal" && <Card title={t(ENTRIES.find((e) => e.id === entry)!.key)} right={<button type="button" className="text-sm underline" onClick={() => setEntry(null)}>{zh ? "回到目标委托" : "Back to goal"}</button>}><EntryPanel entry={entry} assets={assets.assets} assetsSource={assets.source} onRetryAssets={reloadAssets} preset={preset} taskId={taskId} /></Card>}
      <MyAgentTasks account={account} />
      <details className="ag-more">
        <summary className="cursor-pointer text-sm font-semibold">{zh ? "更多：固定自动化工具、第一分钟、今晚的 Crew 与任务" : "More: fixed automation tools, first minute, tonight's crew and missions"}</summary>
        <div className="mt-3 space-y-5">
          <div className="ag-entries" role="tablist" aria-label={zh ? "其它入口" : "Other entries"}>
            {ENTRIES.filter((e) => e.id !== "goal").map((e) => {
              const Icon = ICONS[e.id];
              return <button key={e.id} type="button" role="tab" className="ag-entry" aria-pressed={entry === e.id} aria-selected={entry === e.id} onClick={() => setEntry(entry === e.id ? null : e.id)}><Icon size={20} aria-hidden="true" /><strong>{t(e.key)}</strong><span>{e.blurb[locale]}</span></button>;
            })}
          </div>
          <FirstMinute assets={assets} onRetryAssets={reloadAssets} />
          <Card title={zh ? "今晚的 Crew" : "Tonight's crew"} right={<span className="ag-note">{zh ? "台词只复述真实响应字段" : "lines quote real response fields only"}</span>}><Crew data={crewData} /></Card>
          <Missions eventsKnown={eventsKnown} />
        </div>
      </details>
    </>
  );
}
