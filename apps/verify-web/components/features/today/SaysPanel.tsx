"use client";
import { AgentSays, SourceChip } from "@/components/kit/AgentSays";
import { EmptyState, ErrorState, LoadingBlock } from "@/components/kit/FourStates";
import type { ResourceState } from "@/lib/useResource";
import { Panel } from "@/components/kit/Panel";
import { Timestamp } from "@/components/kit/Timestamp";
import { useI18n } from "@/lib/i18n";
import type { Saying } from "./model";

/** Agent 刚说：最近更新的 3 个未结束任务里，最新 3 条 Agent 原话（按它的策略语言，不改写），附所属任务链接；活动流在事件之后才拉 */
export function SaysPanel({ items, state, onRetry }: { items: Saying[]; state: ResourceState; onRetry: () => void }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  return (
    <Panel className="ch-today-says">
      <Panel.Header title={zh ? "Agent 刚说" : "The agent just said"} />
      <Panel.Body className="ch-today-sayings">
        {state === "loading" || state === "idle" ? (
          <LoadingBlock rows={3} onRetry={onRetry} label={zh ? "Agent 发言读取中" : "Loading the agent's words"} />
        ) : state === "error" ? (
          <ErrorState size="sm" onRetry={onRetry} title={zh ? "Agent 发言没有拿到" : "Could not load the agent's words"} />
        ) : items.length === 0 ? (
          <EmptyState size="sm" title={zh ? "最近没有 Agent 发言" : "No recent words from the agent"} description={zh ? "运行中的任务里，Agent 做决定或等待时说的话会出现在这里。" : "When the agent decides or waits on a running task, its words show up here."} />
        ) : items.map((s) => (
          <AgentSays className="ch-today-saying" key={s.key} who={<span className="ch-today-saying-title" title={s.title}>{s.title}</span>} meta={<Timestamp at={s.at} mode="rel" />} source={<SourceChip href={`/agent/tasks/${s.taskId}`}>{zh ? "看任务" : "Open task"}</SourceChip>}>
            <span className="line-clamp-4" title={s.quote}>{s.quote}</span>
          </AgentSays>
        ))}
      </Panel.Body>
    </Panel>
  );
}
