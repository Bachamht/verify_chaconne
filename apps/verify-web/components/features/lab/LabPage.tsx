"use client";
/**
 * v8 /agent/lab（方案 §5.8）：顶部共用任务（?task=，兼容旧的 ?taskId=）+ 三个 Tabs（?tab=diagnose|compare|replay，兼容旧锚点 #wait/#compare/#replay）。
 * 等待诊断、双策略对照、决策回放在 v8 里只有这一处实现；接口调用沿用 components/agent/lab/api.ts。
 */
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useI18n } from "@/lib/i18n";
import { agentTasks } from "@/lib/api-v2";
import { loadAssets, type AssetEntry } from "@/lib/assets";
import { useResource } from "@/lib/useResource";
import { useQueryState } from "@/lib/useQueryState";
import { WalletGate } from "@/components/WalletGate";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/kit/PageHeader";
import { ModeTag } from "@/components/kit/StatusBadge";
import { Panel } from "@/components/kit/Panel";
import { ErrorState } from "@/components/kit/FourStates";
import { tabFromLegacy, type LabTab } from "./labText";
import { TaskPicker } from "./TaskPicker";
import { DiagnoseTab } from "./DiagnoseTab";
import { CompareTab } from "./CompareTab";
import { ReplayTab } from "./ReplayTab";

export function LabRoute() {
  return <WalletGate>{(account) => <LabPage owner={account} />}</WalletGate>;
}

export function LabPage({ owner }: { owner: string }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const sp = useSearchParams();
  const [taskQ, setTask] = useQueryState("task");
  const task = taskQ || sp?.get("taskId") || "";
  const [, setTab] = useQueryState("tab", "diagnose");
  const [hash, setHash] = useState<string | null>(null);
  useEffect(() => { setHash(window.location.hash || null); }, []);
  const tab: LabTab = tabFromLegacy(hash, sp?.get("tab") ?? null);

  const who = owner.toLowerCase();
  const tasks = useResource(`lab-tasks:${who}`, () => agentTasks.list(who));
  // 资产登记表：没读到要说出来（回放选不了股票、任务名换不了），不静默
  const assetsRes = useResource("lab-assets", async () => {
    const r = await loadAssets();
    return { status: r.source === "none" ? 503 : 200, data: r.assets };
  });
  const assets = useMemo<AssetEntry[]>(() => assetsRes.data ?? [], [assetsRes.data]);
  const list = useMemo(() => tasks.data?.tasks ?? [], [tasks.data]);
  const current = list.find((t) => t.id === task) ?? null;
  const asset = current?.goal?.legs?.[0]?.outputAssetKey ?? sp?.get("asset") ?? null;

  function onTab(v: string) {
    if (hash) { history.replaceState(null, "", window.location.pathname + window.location.search); setHash(null); }
    setTab(v);
  }

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader
        title={zh ? "实验" : "Lab"}
        description={zh ? "为什么没买？换一种规则会怎样？当时的数据会放行吗？三块用同一套证据与条件求值，都不输出收益，也不改你的真实任务。" : "Why hasn't it bought? What if the rule were different? Would the data known then have passed? All three use the same evidence and condition evaluation, report no returns, and never touch your real task."}
        className="mb-0"
      />
      {assetsRes.state === "error" ? (
        <Panel><ErrorState size="sm" status={assetsRes.status ?? 0} title={zh ? "资产登记表没有读到" : "Could not read the asset registry"} description={zh ? "股票名和回放的股票列表要用它；重试一次通常就好。" : "Stock names and the replay stock list need it; a retry usually fixes it."} onRetry={assetsRes.reload} /></Panel>
      ) : null}
      <TaskPicker tasks={list} state={tasks.state} assets={assets} value={task} onChange={(id) => setTask(id)} onRetry={tasks.reload} />
      <Tabs value={tab} onValueChange={onTab} className="min-w-0 gap-4">
        <TabsList className="w-full sm:w-fit">
          <TabsTrigger value="diagnose">{zh ? "诊断" : "Diagnose"}</TabsTrigger>
          <TabsTrigger value="compare">{zh ? "对照" : "Compare"}</TabsTrigger>
          <TabsTrigger value="replay">{zh ? "回放" : "Replay"}</TabsTrigger>
        </TabsList>
        <TabsContent value="diagnose" className="min-w-0"><DiagnoseTab taskId={task} /></TabsContent>
        <TabsContent value="compare" className="min-w-0"><CompareTab key={task} taskId={task} badge={<ModeTag mode="SIMULATION" />} /></TabsContent>
        <TabsContent value="replay" className="min-w-0"><ReplayTab key={task} assets={assets} assetsFailed={assetsRes.state === "error"} initialAsset={asset} initialDate={sp?.get("date") ?? null} /></TabsContent>
      </Tabs>
    </div>
  );
}
