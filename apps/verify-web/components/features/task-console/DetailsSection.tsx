"use client";
/**
 * 「核验细节与开发者信息」（默认折叠；原始 JSON 只在这里）：每轮分析、接管设置、计划条件、决策记录导出、原始视图。
 * 每轮分析与接管暂沿用 v7 组件（行为不变），外观待阶段 5 统一。
 */
import Link from "next/link";
import { ChevronRight } from "lucide-react";
import type { TaskCreated } from "@/lib/api-v2";
import type { TaskRuntime } from "@chaconne/core/verify";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { CodeBlock } from "@/components/kit/CodeBlock";
import { Panel } from "@/components/kit/Panel";
import { conditionText } from "@/lib/conditions";
import { useI18n } from "@/lib/i18n";
import { RunList } from "@/components/agent/tasks/v7/RunList";
import { HandoverCard } from "@/components/agent/tasks/v7/Handover";

export function DetailsSection({ id, view, runtime, sim, fixture, account, refreshKey, onChanged, controlsBusy }: {
  id: string;
  view: TaskCreated;
  runtime: TaskRuntime | null;
  sim: boolean;
  fixture: boolean;
  account: string | null;
  refreshKey: number;
  onChanged: (m: { text: string; tone: "ok" | "bad" | "warn" | "info" }) => void;
  controlsBusy: boolean;
}) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const task = view.task;
  return (
    <Collapsible className="rounded-lg border bg-card" data-testid="v8-verification-details">
      <CollapsibleTrigger className="group flex w-full items-center gap-2 px-5 py-4 text-left">
        <ChevronRight className="size-4 text-fg-3 transition-transform duration-200 group-data-[state=open]:rotate-90" aria-hidden="true" />
        <span className="text-md font-semibold text-fg-1">{zh ? "核验细节与开发者信息" : "Verification details and developer info"}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="flex flex-col gap-4 px-5 pb-5">
        <section>
          <h3 className="mb-2 text-sm font-medium text-fg-2">{zh ? "每轮分析（一轮完成不代表已成交）" : "Analysis by round (a finished round is not a fill)"}</h3>
          <RunList taskId={id} fixture={fixture} mode={sim ? "SIMULATION" : "LIVE"} refreshKey={refreshKey} />
        </section>
        {task.scope?.issuance === "agent" ? (
          <section>
            <h3 className="mb-2 text-sm font-medium text-fg-2">{zh ? "谁来决策、谁来执行" : "Who decides and who executes"}</h3>
            <HandoverCard taskId={id} runtime={runtime} sim={sim} fixture={fixture} disabled={controlsBusy || !runtime || !view.mode} onChanged={onChanged} />
          </section>
        ) : null}
        <Panel>
          <Panel.Header level={3} title={zh ? `计划条件 · ${task.conditions.items.length}` : `Plan conditions · ${task.conditions.items.length}`} description={task.scope ? (zh ? "计划条件在签名之外：可以改，不用重签；硬约束在「边界」里。" : "Plan conditions are outside the signature; hard constraints are in Boundary.") : undefined} />
          <Panel.Body>
            {task.conditions.items.length === 0 ? <p className="text-sm text-fg-3">{zh ? "没有计划条件。" : "No plan conditions."}</p> : (
              <ul className="flex list-disc flex-col gap-1 pl-5 text-sm text-fg-1">{task.conditions.items.map((c, i) => <li key={i}>{conditionText(c, locale)}</li>)}</ul>
            )}
          </Panel.Body>
        </Panel>
        <p className="text-sm text-fg-2">
          <a className="text-brand-400 hover:text-brand-300" href={`/api/verify/v1/tasks/${task.id}/bundle${account ? `?owner=${account.toLowerCase()}` : ""}`} target="_blank" rel="noopener noreferrer">{zh ? "导出决策记录（JSON）" : "Export the decision bundle (JSON)"}</a>
          <span className="mx-2 text-fg-3">·</span>
          <Link className="text-brand-400 hover:text-brand-300" href={`/verify-bundle?task=${encodeURIComponent(task.id)}`}>{zh ? "离线验证" : "Verify offline"}</Link>
          <span className="mt-1 block text-xs text-fg-3">{zh ? "决策记录包含目标与范围、策略全部版本、每一轮、每条意图的依据与四道核验、证书与成交回执；bundleHash 覆盖全部内容，可离线复算。" : "The bundle covers goal and scope, every strategy version, every turn, each intent's basis and four checks, certificates and fills; bundleHash covers everything and can be recomputed offline."}</span>
        </p>
        <CodeBlock language="json" code={JSON.stringify({ task: { id: task.id, status: task.status, blockers: task.blockers, nextCheckAt: task.nextCheckAt, mandateIds: task.mandateIds }, mode: view.mode, steps: view.steps, mandates: view.mandates, agentTurn: view.agentTurn, runtime }, null, 2)} />
      </CollapsibleContent>
    </Collapsible>
  );
}
