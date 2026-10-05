"use client";
/**
 * /start 引导（方案 §5.2）：交代 → 观察 → 授权 → 任务台，四步结构不变，换成 kit。
 * 第 1 步左表单（与 /agent/new 共用 task-form）右范围摘要；手机单栏时摘要折叠到顶部。吉祥物只在第 1 步。
 * 不做：账户 / 登录逻辑（WalletGate 与 lib/wallet 原样）、签名逻辑（useDelegationWizard 原样）。
 */
import Link from "next/link";
import type { ReactNode } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { EmptyState, LoadingBlock } from "@/components/kit/FourStates";
import { Mascot } from "@/components/kit/Mascot";
import { PageHeader } from "@/components/kit/PageHeader";
import { Panel } from "@/components/kit/Panel";
import { ModeTag } from "@/components/kit/StatusBadge";
import { StepFlow } from "@/components/kit/StepFlow";
import { useI18n } from "@/lib/i18n";
import { tv } from "@/lib/i18n.v7";
import { AssetsGate } from "../task-form/AssetsGate";
import { peekText } from "../task-form/model";
import { ScopeSummary } from "../task-form/ScopeSummary";
import { SummaryLayout } from "../task-form/SummaryLayout";
import { taskConsoleHref } from "../task-form/submit";
import { useTradableAssets } from "../task-form/useTradableAssets";
import dynamic from "next/dynamic";
import { DescribeStage } from "./DescribeStage";
import { GoLivePanel } from "./GoLivePanel";
import { STAGES, useStartJourney } from "./useStartJourney";


/** 第 2、3 步才用到（活动轮询、钱包签名）：按需加载，第 1 步首屏不带 */
const WatchPanel = dynamic(() => import("./WatchPanel").then((m) => m.WatchPanel));
const DelegationSteps = dynamic(() => import("./DelegationSteps").then((m) => m.DelegationSteps));

const STEP_KEYS = ["st_step1", "st_step2", "st_step3", "st_step4"] as const;

export function StartFlow({ owner, fixture }: { owner: string; fixture: boolean }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const assets = useTradableAssets(fixture);
  const j = useStartJourney({ owner, fixture, assets });
  const at = STAGES.indexOf(j.stage);
  const observed = j.journey.observation;
  const sDraft = j.stage === "describe" ? j.draft : observed?.draft ?? null;
  const sStable = j.stage === "describe" ? j.stable : observed?.stable ?? null;
  const deadline = j.stage === "describe" ? null : observed?.body.scope?.deadline ?? null;
  const summary = sDraft ? <ScopeSummary draft={sDraft} stable={sStable} assets={assets.assets} deadline={deadline} /> : null;
  const layout = (main: ReactNode) => (summary && sDraft ? <SummaryLayout main={main} summary={summary} peek={peekText(sDraft, sStable?.displaySymbol ?? "", locale)} /> : main);
  return (
    <div className="flex min-w-0 flex-col gap-6" data-testid="start-v8" data-stage={j.stage}>
      <div className="flex min-w-0 items-start gap-6">
        <PageHeader className="mb-0 flex-1" title={zh ? "交代一个任务，先看它跑，再交给它" : "Describe a task, watch it run, then hand it over"} description={zh ? "内置的 Chaconne Agent 会看事件、做判断。先观察它怎么工作，满意了再授权真实交易。" : "The built-in Chaconne Agent follows events and makes decisions. Watch it work before you authorize real trades."} badges={fixture ? <ModeTag mode="FIXTURE" /> : null} />
        {j.stage === "describe" ? <Mascot alt={zh ? "Chaconne 小指挥家" : "Chaconne conductor"} className="hidden shrink-0 md:block" /> : null}
      </div>
      <p className="text-sm text-fg-2 sm:hidden">
        {zh ? `第 ${at + 1} 步，共 4 步：` : `Step ${at + 1} of 4: `}<span className="font-medium text-fg-1">{tv(locale, STEP_KEYS[at]!)}</span>
      </p>
      <StepFlow orientation="horizontal" aria-label={zh ? "步骤" : "Steps"} className="hidden sm:flex">
        {STEP_KEYS.map((k, i) => <StepFlow.Step key={k} index={i + 1} locale={locale} last={i === STEP_KEYS.length - 1} title={tv(locale, k)} state={i < at ? "done" : i === at ? "active" : "idle"} />)}
      </StepFlow>
      {fixture ? <p className="text-sm text-warn">{tv(locale, "fixture_note")}</p> : null}
      {j.saveFailed ? <Alert><AlertDescription className="text-fg-2">{zh ? "浏览器暂时不能保存本页进度。已创建的任务仍可在任务列表找到。" : "This browser cannot save progress. Created tasks remain in the task list."}</AlertDescription></Alert> : null}
      {!j.restored ? <LoadingBlock rows={4} />
        : j.missing ? (
          <Panel>
            <EmptyState title={zh ? "从任务列表接着走" : "Continue from your tasks"} description={zh ? "这个标签页没有对应的流程记录。已创建的任务不会丢，可以在任务列表继续授权或查看活动。" : "This tab has no matching journey. Created tasks are kept; continue authorization or view activity from the task list."} action={<><Button asChild size="sm"><Link href="/agent/tasks">{zh ? "打开任务列表" : "Open tasks"}</Link></Button><Button asChild size="sm" variant="outline"><Link href={j.startHref("describe")}>{zh ? "交代一个新目标" : "Start a new goal"}</Link></Button></>} />
          </Panel>
        )
        : j.stage === "describe" ? <AssetsGate assets={assets}>{layout(<DescribeStage j={j} assets={assets} />)}</AssetsGate>
        : j.stage === "watch" && observed ? layout(<>
          <WatchPanel taskId={observed.id} fixture={fixture} assets={assets.assets} stableKey={observed.stable.assetKey} consoleHref={taskConsoleHref(observed.id, fixture)} />
          <GoLivePanel j={j} />
        </>)
        : j.stage === "live" && j.journey.liveId ? layout(
          <Panel>
            <Panel.Header title={tv(locale, "d_title")} description={zh ? "逐项核对预算、卖出范围和代币额度。以清单状态为准；请求被受理不等于成交。" : "Check each budget, sell scope and token allowance. Follow the checklist; an accepted request is not a fill."} />
            <Panel.Body className="flex flex-col gap-4">
              {fixture ? <p className="text-sm text-warn">{zh ? "以下授权清单是固定示例，不随本页预算变化。真实任务的清单由服务端按实际范围生成。" : "The checklist below is a fixed example and does not follow this preview budget. Real checklists are generated from the actual scope."}</p> : null}
              <DelegationSteps taskId={j.journey.liveId} owner={owner} fixture={fixture} taskHref={taskConsoleHref(j.journey.liveId, fixture)} onComplete={() => j.router.push(taskConsoleHref(j.journey.liveId!, fixture))} />
            </Panel.Body>
          </Panel>,
        ) : null}
      <Panel as="section" aria-label={zh ? "教学入口" : "Walkthrough"}>
        <Panel.Body className="flex flex-col gap-3 pt-5 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-fg-2"><span className="font-medium text-fg-1">{tv(locale, "st_teach_h")}</span> {tv(locale, "st_teach_p")}</p>
          <Button asChild variant="outline" size="sm" className="self-start sm:self-auto"><Link href="/start?mode=play">{tv(locale, "st_teach_cta")}</Link></Button>
        </Panel.Body>
      </Panel>
    </div>
  );
}
