"use client";
/**
 * v8 任务控制台（方案 §5.6）：保留 v7 的「它接手了吗 / 需要我处理什么 / 已经做成什么」，补上时间线与边界。
 * PageHeader → KpiRow → 两栏（左：现在 + 步骤时间线；右：需要你 + 边界 + 持仓）→ 活动记录 → 核验细节（折叠）。
 */
import type { DeepAction } from "@/lib/useDeepAction";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import type { NeedsOwnerItem, TradeMandate } from "@chaconne/core/verify";
import { mandates, notReady, taskV7Extras } from "@/lib/api-v2";
import { assetByKey } from "@/lib/assets";
import { useI18n } from "@/lib/i18n";
import { humanizeActivity, actorLabel } from "@/lib/activityText";
import { Amount } from "@/components/kit/Amount";
import { Countdown } from "@/components/kit/Timestamp";
import { ErrorState, LoadingBlock } from "@/components/kit/FourStates";
import { KpiRow, StatTile } from "@/components/kit/StatTile";
import { Panel } from "@/components/kit/Panel";
import { DelegationWizard } from "@/components/agent/delegation/DelegationWizard";
import { blockerSentence, taskTitle } from "@/components/agent/tasks/taskTitle";
import { useActivityFeed } from "@/components/agent/tasks/v7/useActivityFeed";
import { usePositions } from "@/components/agent/tasks/v7/Positions";
import { activityCategory } from "@/components/agent/tasks/v7/runtimeModel";
import { useTaskConsoleData, useAssetsList, type ConsoleData } from "./useTaskConsoleData";
import { useTaskControls } from "./useTaskControls";
import { consoleStatus, primaryAction, spentRaw, visibleNextCheck } from "./consoleModel";
import { ConsoleHeader } from "./ConsoleHeader";
import { NowPanel } from "./NowPanel";
import { NeedsPanel } from "./NeedsPanel";
import { StepsPanel } from "./StepsPanel";
import { BoundaryPanel } from "./BoundaryPanel";
import { HoldingsPanel } from "./HoldingsPanel";
import { ActivityPanel } from "./ActivityPanel";
import { DetailsSection } from "./DetailsSection";

export function TaskConsole({ id }: { id: string }) {
  const { res, fixture, account } = useTaskConsoleData(id);
  const { locale } = useI18n();
  if (res.state === "loading" || res.state === "idle") return <LoadingBlock label={locale === "zh" ? "正在读取任务" : "Loading the task"} shape={<ConsoleSkeleton />} onRetry={res.reload} />;
  if (res.state === "error" || !res.data) return <ErrorState status={res.status ?? 0} title={res.status === 404 ? (locale === "zh" ? "没有找到这个任务" : "Task not found") : undefined} description={res.status === 404 ? (locale === "zh" ? "它可能属于另一个钱包，或已经删除。确认页头连接的是创建它的钱包。" : "It may belong to another wallet or was removed. Check that the header shows the wallet that created it.") : undefined} onRetry={res.reload} />;
  // key：换任务 / 换示例模式时整页重置（向导、游标、持仓都只属于一个任务）
  return <ConsoleBody key={`${id}:${fixture}:${res.data.view.mode ?? "?"}`} id={id} data={res.data} fixture={fixture} account={account} reload={res.reload} />;
}

function ConsoleBody({ id, data, fixture, account, reload }: { id: string; data: ConsoleData; fixture: boolean; account: string | null; reload: () => void }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const assets = useAssetsList(fixture);
  const { view, fills } = data;
  const task = view.task;
  const extras = taskV7Extras(view);
  const mode = view.mode === "LIVE" || view.mode === "SIMULATION" ? view.mode : null;
  const sim = mode === "SIMULATION";
  const feed = useActivityFeed(id, { fixture, mode: mode ?? undefined, initialRuntime: extras.runtime });
  const runtime = feed.runtime;
  const fillEvents = feed.items.filter((x) => activityCategory(x) === "fill_confirmed").length;
  const pos = usePositions(id, fixture, extras.positions, fillEvents);
  const controls = useTaskControls(id, account, reload);
  const stableKey = task.scope?.inputAssetKey ?? task.goal?.budget?.inputAssetKeys?.[0] ?? null;
  const stable = assetByKey(assets, stableKey);
  const st = consoleStatus({ status: task.status, mode });
  const facts = { status: task.status, mode, runtime, delegationComplete: extras.delegation?.complete ?? null, plannedSteps: extras.stepsV7?.buy?.planned ?? view.steps?.planned ?? task.scope?.maxSteps ?? null, fills };
  const primary = primaryAction(facts);
  const [wizard, setWizard] = useState(false);
  const wizardRef = useRef<HTMLDivElement>(null);
  const showWizard = !sim && (primary === "delegate" || wizard);
  const buyMandate = (view.mandates ?? []).find((m) => m.current) ?? (view.mandates ?? [])[0] ?? null;
  const revokeMandate = useMandate(task.mandateIds[task.mandateIds.length - 1] ?? null, !sim && !fixture);
  const nextCheck = visibleNextCheck({ status: task.status, runtime }, task.nextCheckAt);
  const spent = spentRaw(view.mandates, fills);
  const held = (pos.rows ?? []).filter((x) => /^\d+$/.test(x.netRaw) && BigInt(x.netRaw) > 0n);
  const quote = useMemo(() => {
    for (let i = feed.items.length - 1; i >= 0; i -= 1) {
      const it = feed.items[i]!;
      const t = humanizeActivity(it, { locale, assets, stableAssetKey: stableKey });
      if (t.quote) return { text: t.quote, at: it.at, who: actorLabel(it.actor, locale) };
    }
    return null;
  }, [feed.items, locale, assets, stableKey]);
  const blockers = task.blockers.map((b) => ({ code: b.code, text: blockerSentence(b, locale), nextCheckAt: b.nextCheckAt ?? null, needsYou: b.userActionRequired }));

  function focusWizard() {
    setWizard(true);
    setTimeout(() => wizardRef.current?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" }), 50);
  }
  // 待办直接打开能做这件事的地方：签名 → 委托面板；继续或取消 → 选择框；链上撤销 → 撤销确认框
  const [request, setRequest] = useState<{ op: DeepAction; n: number } | null>(null);
  function onNeed(item: NeedsOwnerItem) {
    if (item.action.kind === "sign_delegation" || item.action.kind === "sign_permit") focusWizard();
    else if (item.action.kind === "resume_or_cancel") setRequest((r) => ({ op: "decide", n: (r?.n ?? 0) + 1 }));
    else if (item.action.kind === "confirm_revoke") setRequest((r) => ({ op: "revoke", n: (r?.n ?? 0) + 1 }));
  }

  return (
    <div className="flex flex-col gap-6" data-testid="task-console-v8">
      {fixture ? <p className="rounded-md border border-warn/35 bg-warn/12 px-3 py-2 text-sm text-fg-1">{zh ? "这是示例数据（FIXTURE），不是你的真实任务。" : "This is fixture data, not a real task of yours."}</p> : null}
      <ConsoleHeader id={id} title={taskTitle(task, view.params, assets, locale)} status={st.status} mode={st.mode} updatedAt={task.updatedAt} primary={primary} stoppable={st.stoppable} paused={st.paused} sim={sim} fixture={fixture} controls={controls} revokeMandate={revokeMandate} onDelegate={focusWizard} hostedExecutor={!sim && runtime?.executorMode === "hosted"} request={request} />
      {!mode ? <p className="text-sm text-warn">{zh ? "任务模式尚未返回，暂时无法确认这是观察任务还是真实资金任务。" : "The task mode has not arrived; we cannot yet confirm whether this is an observation or a live task."}</p> : null}
      <KpiRow>
        <StatTile label={zh ? "已成交步数" : "Steps filled"} value={facts.plannedSteps !== null ? <span>{extras.stepsV7?.buy?.confirmed ?? view.steps?.confirmed ?? "—"} / {facts.plannedSteps}</span> : null} hint={sim ? (zh ? "观察任务不成交" : "Observation does not trade") : undefined} />
        <StatTile label={zh ? "已用预算" : "Budget used"} value={sim ? null : spent !== null ? <Amount raw={spent} decimals={stable?.tokenDecimals ?? null} symbol={stable?.displaySymbol} maxFrac={2} /> : null} hint={task.scope ? <>{zh ? "上限 " : "Cap "}<Amount raw={task.scope.budgetCapRaw} decimals={stable?.tokenDecimals ?? null} symbol={stable?.displaySymbol} maxFrac={2} /></> : undefined} />
        <StatTile label={zh ? "本任务持仓" : "Holdings"} value={pos.rows === null ? null : held.length === 0 ? (zh ? "无" : "None") : held.map((h) => assetByKey(assets, h.assetKey)?.displaySymbol ?? (zh ? "未登记资产" : "Unregistered asset")).join(" · ")} />
        <StatTile label={zh ? "下次检查" : "Next check"} value={nextCheck ? <Countdown to={nextCheck} doneLabel={zh ? "检查中" : "Checking"} /> : null} hint={st.paused ? (zh ? "已暂停，不安排检查" : "Paused; no check scheduled") : st.terminal ? (zh ? "任务已结束" : "Task has ended") : undefined} />
      </KpiRow>
      {showWizard ? (
        <div ref={wizardRef} className="scroll-mt-20">
          <Panel tone="brand">
            <Panel.Header title={zh ? "委托 Chaconne Agent" : "Delegate to Chaconne Agent"} description={zh ? "逐项签名，不发交易。签名数：买入 2 次，每只允许卖出的股票再加 2 次。" : "Sign item by item; no transaction is sent. Signatures: 2 for buying, plus 2 for each stock you allow it to sell."} />
            <Panel.Body><DelegationWizard taskId={id} owner={task.owner} fixture={fixture} onComplete={() => { setWizard(false); reload(); }} /></Panel.Body>
          </Panel>
        </div>
      ) : null}
      {/* 单栏（<1050）时「需要你」放最前；两栏时在右栏顶部 */}
      <div className="min-[1050px]:hidden"><NeedsPanel runtime={runtime} onAction={onNeed} /></div>
      <div className="grid gap-6 min-[1050px]:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-6">
          <NowPanel runtime={runtime} sim={sim} nextCheckAt={nextCheck} delegation={{ complete: extras.delegation?.complete ?? null, done: extras.delegation?.counts?.signaturesDone ?? null, needed: extras.delegation?.counts?.signaturesNeeded ?? null }} blockers={blockers} paused={st.paused} latestQuote={quote} />
          <StepsPanel planned={facts.plannedSteps} fills={fills} buyMandateId={buyMandate?.mandateId ?? null} running={st.stoppable} stable={stable} sim={sim} />
        </div>
        <div className="flex min-w-0 flex-col gap-6">
          <div className="hidden min-[1050px]:block"><NeedsPanel runtime={runtime} onAction={onNeed} /></div>
          {task.scope ? <BoundaryPanel scope={task.scope} assets={assets} stable={stable} /> : null}
          <HoldingsPanel rows={pos.rows} nr={pos.nr} assets={assets} allowSell={Boolean(task.scope?.allowSell)} onRetry={() => void pos.reload()} />
        </div>
      </div>
      <ActivityPanel feed={feed} sim={sim} assets={assets} stableKey={stableKey} />
      <DetailsSection id={id} view={view} runtime={runtime} sim={sim} fixture={fixture} account={account} refreshKey={feed.items.length} controlsBusy={controls.pending !== null} onChanged={(m) => { (m.tone === "ok" ? toast.success : m.tone === "bad" ? toast.error : toast.info)(m.text); if (m.tone === "ok") { feed.refresh(); reload(); } }} />
    </div>
  );
}

/** 链上撤销需要 mandate 原文 */
function useMandate(mandateId: string | null, enabled: boolean): TradeMandate | null {
  const [m, setM] = useState<TradeMandate | null>(null);
  useEffect(() => {
    if (!mandateId || !enabled) return;
    mandates.get(mandateId).then((r) => { if (r.status === 200 && !notReady(r) && r.data.mandate) setM(r.data.mandate); }).catch(() => undefined);
  }, [mandateId, enabled]);
  return m;
}

function ConsoleSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <div className="h-14 w-2/3 rounded-md bg-surface-2" />
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{[0, 1, 2, 3].map((i) => <div key={i} className="h-24 rounded-lg bg-surface-1" />)}</div>
      <div className="grid gap-6 min-[1050px]:grid-cols-[minmax(0,1fr)_340px]"><div className="h-72 rounded-lg bg-surface-1" /><div className="h-72 rounded-lg bg-surface-1" /></div>
    </div>
  );
}
