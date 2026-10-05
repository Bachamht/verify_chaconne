"use client";
/**
 * 任务页 v7 运行台（P3，只在 NEXT_PUBLIC_V7_UI=1 时挂载）：
 * 当前状态 / 待办 → 委托向导 → 活动流与可展开轮次 → 持仓 / 接管 → 任务控制。
 * 核验细节与开发者信息由 TaskDetail 折叠在下方。
 */
import Link from "next/link";
import { useRef, useState, type ReactNode } from "react";
import type { NeedsOwnerItem } from "@chaconne/core/verify";
import { taskV7Extras, v7, type TaskCreated } from "@/lib/api-v2";
import { apiError } from "@/lib/errors";
import type { AssetEntry } from "@/lib/assets";
import { Card } from "@/components/ui";
import { DelegationWizard } from "../../delegation/DelegationWizard";
import { ActivityFeed } from "./ActivityFeed";
import { FourQuestions } from "./FourQuestions";
import { HandoverCard } from "./Handover";
import { PositionsCard, usePositions } from "./Positions";
import { RunList } from "./RunList";
import { activityCategory } from "./runtimeModel";
import { useActivityFeed } from "./useActivityFeed";
import { useV7 } from "./useV7";
import "../../v7.css";
import styles from "./console.module.css";

export interface ConsoleControls {
  pending: string | null;
  stoppable: boolean;
  paused: boolean;
  onPause: () => void;
  onResume: () => void;
  onCancel: () => void;
  onDelete: () => void;
  revokeSlot: ReactNode;
  /** 旧部署（没有委托清单）时的单签授权按钮 */
  legacyAuthorizeSlot?: ReactNode;
}

export function TaskConsoleV7(props: Parameters<typeof TaskConsole>[0]) {
  // Local wizard, share link and positions also belong to one task only.
  return <TaskConsole key={`${props.id}:${props.fixture}:${props.view.mode ?? "unknown"}`} {...props} />;
}

function TaskConsole({ id, view, fills, assets, stable, fixture, controls, onToast, onReload }: {
  id: string;
  view: TaskCreated;
  fills: Array<{ mandateId: string; stepIndex: string; state: string; txHash: string | null }>;
  assets: AssetEntry[];
  stable: AssetEntry | null;
  fixture: boolean;
  controls: ConsoleControls;
  onToast: (m: { text: string; tone: "ok" | "bad" | "warn" | "info" }) => void;
  onReload: () => void;
}) {
  const { s, locale } = useV7();
  const zh = locale === "zh";
  const task = view.task;
  const extras = taskV7Extras(view);
  const mode = view.mode === "LIVE" || view.mode === "SIMULATION" ? view.mode : undefined;
  const sim = mode === "SIMULATION";
  const feed = useActivityFeed(id, { fixture, mode, initialRuntime: extras.runtime });
  const runtime = feed.runtime;
  const fillEvents = feed.items.filter((x) => activityCategory(x) === "fill_confirmed").length;
  const pos = usePositions(id, fixture, extras.positions, fillEvents);
  const [showWizard, setShowWizard] = useState(false);
  const [share, setShare] = useState<string | null>(null);
  const wizardRef = useRef<HTMLDivElement>(null);

  const needsDelegation = !sim && (runtime?.needsOwner?.some((n) => n.code === "delegation_incomplete") || extras.delegation?.complete === false || (task.status === "AWAITING_AUTHORIZATION" && !!runtime));
  const wizardOpen = !sim && (needsDelegation || showWizard);
  const confirmed = fills.filter((f) => f.state === "CONFIRMED" && f.txHash);
  const latest = confirmed[confirmed.length - 1] ?? null;
  const buyMandate = (view.mandates ?? []).find((m) => m.current) ?? (view.mandates ?? [])[0];

  function scrollTo(element: HTMLElement | null) {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    element?.scrollIntoView({ behavior: reduce ? "instant" : "smooth", block: "start" });
  }

  function onAction(item: NeedsOwnerItem) {
    if (item.action.kind === "sign_delegation" || item.action.kind === "sign_permit") {
      setShowWizard(true);
      setTimeout(() => scrollTo(wizardRef.current), 50);
    } else if (item.action.kind === "resume_or_cancel") {
      if (controls.paused) controls.onResume();
    } else if (item.action.kind === "confirm_revoke") {
      scrollTo(document.getElementById("v7-controls"));
    }
  }
  async function createShare() {
    if (fixture) { setShare(`${typeof window !== "undefined" ? window.location.origin : ""}/live/agent/shr_fixture?v7fixture=1`); return; }
    const r = await v7.shareActivity(id).catch(() => null);
    if (!r || r.status === 0) return onToast({ text: s("unreachable"), tone: "bad" });
    if (r.status !== 200 && r.status !== 201) return onToast({ text: apiError(r, locale), tone: "bad" });
    setShare(`${window.location.origin}/live/agent/${r.data.shareId}`);
  }

  return (
    <div className={styles.console} data-testid="task-console-v7">
      {fixture && <p className="ag-warn">{s("fixture_note")}</p>}
      <div className={styles.consoleHeader}>
        <p>{zh ? "任务运行台" : "TASK CONSOLE"}<span>{zh ? "先看状态，再看发生了什么。" : "Status first. The full story below."}</span></p>
        <nav className={styles.shortcuts} aria-label={zh ? "运行台导航" : "Task console navigation"}>
          <a href="#v7-activity">{zh ? "活动记录" : "Activity"}</a>
          <a href="#v7-assets">{zh ? "持仓与接管" : "Holdings & handover"}</a>
          <a href="#v7-controls">{zh ? "任务控制" : "Controls"}</a>
        </nav>
      </div>
      {!mode && <p className={styles.notice}>{zh ? "任务模式尚未返回；暂时无法确认这是观察任务还是真实资金任务。" : "The task mode has not arrived. We cannot yet confirm whether this is an observation or a live task."}</p>}
      <FourQuestions
        runtime={runtime}
        delegationCounts={extras.delegation?.counts ?? null}
        delegationComplete={extras.delegation?.complete ?? null}
        fills={{ buy: extras.stepsV7?.buy?.confirmed ?? view.steps?.confirmed ?? (confirmed.length > 0 ? confirmed.length : null), sell: extras.stepsV7?.sell?.confirmed ?? null, planned: extras.stepsV7?.buy?.planned ?? view.steps?.planned ?? task.scope?.maxSteps ?? null, latest: latest ? { txHash: latest.txHash } : null }}
        positions={pos.rows}
        budget={{ capRaw: task.scope?.budgetCapRaw ?? null, spentRaw: buyMandate?.spent ?? null, decimals: stable?.tokenDecimals ?? null, symbol: stable?.displaySymbol ?? "" }}
        assets={assets}
        sim={sim}
        modeKnown={mode !== undefined}
        onAction={onAction}
      />
      {wizardOpen && (
        <div ref={wizardRef} id="v7-delegation" className={styles.delegation}>
          <Card title={s("d_title")}>
            <p className="ag-note mb-3">{s("d_lead")}</p>
            <DelegationWizard taskId={id} owner={task.owner} fixture={fixture} onComplete={() => { setShowWizard(false); onReload(); }} />
          </Card>
        </div>
      )}
      <section className={styles.journal} id="v7-activity" aria-label={zh ? "活动与分析记录" : "Activity and analysis records"}>
        <div className={styles.sectionHeading}><p>{zh ? "过程与依据" : "ACTIVITY & REASONING"}</p><span>{zh ? "活动记录发生了什么；轮次记录解释 Agent 的分析。" : "Activity shows what happened. Rounds explain the agent’s analysis."}</span></div>
        <ActivityFeed feed={feed} sim={sim} />
        <details className={styles.rounds}>
          <summary><span><strong>{zh ? "查看每轮分析与依据" : "Explore analysis by round"}</strong><span>{zh ? "工具调用、判断与证据，按轮次展开。" : "Tools, decisions, and evidence, one round at a time."}</span></span><span className={styles.expandMark} aria-hidden="true">+</span></summary>
          <div className={styles.roundsContent}>
            <p className={styles.roundsNote}>{zh ? "一轮分析可能决定继续等待；轮次完成并不代表已经成交。" : "A round may decide to keep waiting. A completed round does not mean a trade was filled."}</p>
            {/* RunList uses this prop only to seed explicit fixtures; fetched rounds carry their own mode. */}
            <RunList taskId={id} fixture={fixture} mode={sim ? "SIMULATION" : "LIVE"} refreshKey={feed.items.length} />
          </div>
        </details>
      </section>
      <div className={styles.assetGrid} id="v7-assets">
        <PositionsCard rows={pos.rows} nr={pos.nr} assets={assets} onRetry={() => void pos.reload()} />
        {task.scope?.issuance === "agent" && <div className={styles.handover}>
          {(!runtime || !mode) && <p className={styles.notice}>{zh ? "当前决策与执行配置还未确认。下方选项暂不可用，待状态返回后再切换。" : "The current agent and executor configuration is unconfirmed. These choices are disabled until its status arrives."}</p>}
          <HandoverCard taskId={id} runtime={runtime} sim={sim} fixture={fixture} disabled={controls.pending !== null || !runtime || !mode} onChanged={(m) => { onToast(m); if (m.tone === "ok") { feed.refresh(); onReload(); } }} />
        </div>}
      </div>
      <div id="v7-controls" className={styles.controls}>
        <Card title={s("ctl_h")}>
          <p className={styles.controlsNote}>{zh ? "暂停、取消与链上额度是不同的操作。请按当前任务状态选择。" : "Pausing, cancelling, and reclaiming on-chain allowance are separate actions. Choose what fits the current task state."}</p>
          <div className="ag-actions">
            {controls.legacyAuthorizeSlot}
            {controls.stoppable && <button type="button" className="btn-ghost" disabled={controls.pending !== null || fixture} onClick={controls.onPause}>{s("ctl_pause")}</button>}
            {controls.paused && <button type="button" className="btn-ghost" disabled={controls.pending !== null || fixture} onClick={controls.onResume}>{s("ctl_resume")}</button>}
            {(controls.stoppable || controls.paused) && <button type="button" className="btn-ghost" disabled={controls.pending !== null || fixture} onClick={controls.onCancel}>{s("ctl_cancel")}</button>}
            {!fixture && controls.revokeSlot}
            {!sim && <Link className="btn-ghost inline-flex items-center" href="/agent/funds#allowances">{s("ctl_reclaim")}</Link>}
            <button type="button" className="btn-ghost" onClick={() => void createShare()}>{s("ctl_share")}</button>
            <button type="button" className="btn-ghost text-bad" disabled={controls.pending !== null || fixture} onClick={controls.onDelete}>{locale === "zh" ? "删除" : "Delete"}</button>
          </div>
          {share && <p className="ag-note mt-2 break-all" role="status">{s("ctl_share_done", { url: share })}</p>}
          {!sim && runtime?.executorMode === "hosted" && <p className="ag-note mt-2">{s("ctl_pause_note")}</p>}
        </Card>
      </div>
    </div>
  );
}
