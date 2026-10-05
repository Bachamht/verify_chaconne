"use client";
/**
 * /tasks/[id] 授权任务（mandate）视图（v8，MarketingShell 内）：进度 → 执行一步 → 时间线 → 步骤回执 → 账单 / 分享。
 * 暂停 / 继续 / 取消 / 链上撤销在 TaskControls，各自二次确认。逻辑在 useTaskMandate（= TaskClient 原逻辑）。
 */
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Amount } from "@/components/kit/Amount";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/kit/FourStates";
import { Hash } from "@/components/kit/Hash";
import { KeyValue } from "@/components/kit/KeyValue";
import { PageHeader } from "@/components/kit/PageHeader";
import { Panel } from "@/components/kit/Panel";
import { ModeTag, StatusBadge, ToneTag } from "@/components/kit/StatusBadge";
import { Timestamp } from "@/components/kit/Timestamp";
import { useI18n } from "@/lib/i18n";
import { evidenceMode, taskUiStatus } from "@/lib/status";
import { requestIdOf } from "@/lib/useResource";
import { BillView } from "@/components/features/report/BillView";
import { ShareView } from "@/components/features/report/ShareView";
import { policyLabel } from "@/components/features/report/labels";
import { unitOf } from "@/components/features/report/model";
import { useAssets } from "@/components/features/report/useJobReport";
import { TaskControls } from "./TaskControls";
import { TaskSteps, TaskTimeline } from "./TaskLists";
import { TaskStepPanel } from "./TaskStepPanel";
import { taskNumbers } from "./taskModel";
import { useTaskMandate } from "./useTaskMandate";

export function TaskPage({ id }: { id: string }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const t = useTaskMandate(id);
  const assets = useAssets();
  const { res, m } = t;

  if (res.state === "loading" || res.state === "idle") return <LoadingBlock rows={6} label={zh ? "正在读取任务" : "Loading the task"} />;
  if (!m) {
    return res.status === 404
      ? <EmptyState title={zh ? "找不到这个任务" : "Task not found"} description={zh ? "链接可能不对，或者任务属于另一个钱包。任务只对创建它的钱包可见。" : "The link may be wrong, or the task belongs to another wallet. Tasks are only visible to the wallet that created them."} action={<Button asChild size="sm"><Link href="/agent/tasks">{zh ? "回到任务列表" : "Back to tasks"}</Link></Button>} />
      : <ErrorState status={res.status ?? 0} requestId={requestIdOf(res.errorBody)} onRetry={res.reload} />;
  }
  const inU = unitOf(assets.data, m.inputAssetKey);
  const n = taskNumbers(m);
  const pct = Number(n.budgetCap) > 0 ? Math.min(100, (Number(n.spent ?? 0) / Number(n.budgetCap)) * 100) : 0;
  const mode = evidenceMode(m.evidenceMode);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader
        title={zh ? "授权任务" : "Authorized task"}
        badges={<><StatusBadge status={taskUiStatus(m.state)} title={m.state} />{mode ? <ModeTag mode={mode} /> : null}</>}
        description={<span className="inline-flex flex-wrap items-center gap-2">{n.policyId ? `${policyLabel(n.policyId, locale)} · ` : null}<Hash value={m.mandateId} kind="id" /></span>}
        actions={<TaskControls t={t} />}
        className="mb-0"
      />
      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <Panel>
          <Panel.Header title={zh ? "进度" : "Progress"} action={<ToneTag tone="neutral">{zh ? `第 ${m.stepsDone} / ${m.maxSteps} 步` : `Step ${m.stepsDone} / ${m.maxSteps}`}</ToneTag>} />
          <Panel.Body className="flex flex-col gap-3">
            <Progress value={pct} aria-label={zh ? "预算使用" : "Budget used"} />
            <KeyValue dense items={[
              { label: zh ? "已用 / 预算上限" : "Spent / budget cap", value: <span><Amount raw={n.spent} decimals={inU.decimals} symbol={inU.symbol} maxFrac={4} /> / <Amount raw={n.budgetCap} decimals={inU.decimals} symbol={inU.symbol} maxFrac={4} /></span> },
              { label: zh ? "单步上限" : "Per-step cap", value: n.perStepCap ? <Amount raw={n.perStepCap} decimals={inU.decimals} symbol={inU.symbol} maxFrac={4} /> : null },
              { label: zh ? "截止时间" : "Deadline", value: <Timestamp at={n.deadline} mode="abs" /> },
              { label: zh ? "授权摘要" : "Mandate digest", value: <Hash value={m.mandateDigest} /> },
            ]} />
            <p className="text-xs text-fg-3">{zh ? "任务结束不会自动撤销链上授权；卖出授权可以动用钱包里原有的持仓。" : "Ending a task does not revoke the on-chain authorization; a sell authorization can use holdings already in the wallet."}</p>
          </Panel.Body>
        </Panel>
        <TaskStepPanel t={t} assets={assets.data} />
      </div>
      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <TaskTimeline m={m} />
        <TaskSteps m={m} assets={assets.data} />
      </div>
      <div className="grid min-w-0 gap-4 lg:grid-cols-2">
        <BillView res={t.bill} assets={assets.data} />
        <ShareView kind="mandate" refId={m.mandateId} template={m.planId ? { kind: "plan", refId: m.planId } : null} />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button asChild variant="ghost" size="sm"><Link href={`/verify-bundle?mandate=${m.mandateId}`}>{zh ? "核对证据包" : "Check the evidence bundle"}</Link></Button>
      </div>
    </div>
  );
}
