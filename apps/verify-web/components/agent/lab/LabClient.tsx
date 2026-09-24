"use client";
/** /agent/lab（C9 决策实验）：等待诊断 → 双策略对照 → 回放时间线。数据取不到显示不可用，不伪装。 */
import { useSearchParams } from "next/navigation";
import { useState } from "react";
import { useI18n } from "@/lib/i18n";
import { ModeBadge } from "@/components/Header";
import { WaitDiagnosis } from "./WaitDiagnosis";
import { PolicyCompare } from "./PolicyCompare";
import { ReplayTimeline } from "./ReplayTimeline";

export function LabClient() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const sp = useSearchParams();
  const initial = sp.get("taskId") ?? sp.get("task") ?? "";
  const [taskId, setTaskId] = useState(initial);
  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-bold">{zh ? "决策实验" : "Decision Lab"}</h1>
        <ModeBadge />
      </div>
      <nav className="flex flex-wrap gap-2 text-xs" aria-label={zh ? "实验页分区" : "Lab sections"}>
        <a className="btn-ghost h-8 px-3" href="#wait">{zh ? "等待诊断" : "Wait diagnosis"}</a>
        <a className="btn-ghost h-8 px-3" href="#compare">{zh ? "双策略对照" : "Two-policy comparison"}</a>
        <a className="btn-ghost h-8 px-3" href="#replay">{zh ? "决策回放" : "Decision replay"}</a>
      </nav>
      <p className="max-w-3xl text-sm text-fg-2">
        {zh
          ? "为什么没买？换一种规则会怎样？三块都建立在同一套证据与条件求值之上：诊断解释全部阻塞项，对照在同一快照上并排试算两套规则，回放只用各时点当时已知的数据。没有任何一块输出收益。"
          : "Why hasn't it bought? What if the rule were different? All three blocks rest on the same evidence and condition evaluation: diagnosis explains every blocker, the comparison runs two rule sets on one snapshot, and the replay uses only data known at each point. None of them reports returns."}
      </p>
      <WaitDiagnosis initialTaskId={initial} onTaskId={setTaskId} />
      <PolicyCompare taskId={taskId} />
      <ReplayTimeline initialAsset={sp.get("asset")} initialDate={sp.get("date")} />
    </div>
  );
}
