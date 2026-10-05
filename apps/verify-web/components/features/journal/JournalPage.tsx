"use client";
/**
 * v8 /agent/journal（方案 §5.8）：日期选择（?date=）+ 回执列表 +「重新生成」。
 * 数据：GET /v1/recaps?owner&date（refresh=1 = 服务端重新生成）；任务标题来自 GET /v1/tasks?owner；资产登记表换算单位。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { RefreshCw } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { agentTasks, isRecapPending, recaps, type RecapView } from "@/lib/api-v2";
import { apiError } from "@/lib/errors";
import { loadAssets, type AssetEntry } from "@/lib/assets";
import { useResource, requestIdOf } from "@/lib/useResource";
import { useQueryState } from "@/lib/useQueryState";
import { taskTitle } from "@/components/agent/tasks/taskTitle";
import { PageHeader } from "@/components/kit/PageHeader";
import { AsyncButton } from "@/components/kit/AsyncButton";
import { ErrorState, LoadingBlock } from "@/components/kit/FourStates";
import { DateControl } from "./DateControl";
import { JournalDay } from "./JournalDay";
import { PendingDay } from "./PendingDay";
import { JournalSkeleton } from "./JournalSkeleton";
import { isDay } from "./receipts";
import { useAccount } from "@/lib/useAccount";

/** 路由入口：钱包地址就是账户（/agent 布局已经包了钱包门禁，这里只等地址恢复） */
export function JournalRoute() {
  const account = useAccount();
  if (!account) return <LoadingBlock shape={<JournalSkeleton />} />;
  return <JournalPage owner={account} />;
}

/** 「重新生成」不可点时的可见原因（C3） */
function regenBlocked(state: string, pending: boolean, zh: boolean): string | undefined {
  if (pending) return zh ? "还没生成，不能重新生成" : "Not generated yet";
  if (state === "loading" || state === "idle") return zh ? "日志读取中" : "Loading the journal";
  if (state === "error") return zh ? "日志没取到，先重试读取" : "The journal did not load; retry first";
  return undefined;
}

export function JournalPage({ owner }: { owner: string }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const [dateQ, setDate] = useQueryState("date");
  const date = isDay(dateQ) ? dateQ : "";
  const who = owner.toLowerCase();
  const recap = useResource(`recap:${who}:${date}`, () => recaps.list(who, date || undefined));
  const tasks = useResource(`tasks:${who}`, () => agentTasks.list(who));
  const [assets, setAssets] = useState<AssetEntry[]>([]);
  useEffect(() => { void loadAssets().then((r) => setAssets(r.assets)); }, []);
  const titles = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of tasks.data?.tasks ?? []) m.set(t.id, taskTitle(t, null, assets, locale));
    return m;
  }, [tasks.data, assets, locale]);
  /** 任务的实时状态（「需要你决定」据此标已处理）；列表没拿到 → null */
  const live = useMemo(() => (tasks.data?.tasks ? new Map(tasks.data.tasks.map((t) => [t.id, String(t.status)])) : null), [tasks.data]);

  const [regen, setRegen] = useState(false);
  const regenerate = useCallback(async () => {
    setRegen(true);
    const r = await recaps.list(who, date || undefined, true).catch(() => null);
    setRegen(false);
    if (r && r.status === 200) {
      toast.success(zh ? "日志已重新生成" : "Journal regenerated");
      recap.reload();
    } else toast.error(zh ? "重新生成没有完成" : "Regeneration did not finish", { description: r ? apiError(r, locale) : (zh ? "服务没有回应，稍后重试。" : "The service did not answer. Retry shortly.") });
  }, [who, date, zh, locale, recap]);

  const shown = recap.data && !isRecapPending(recap.data) ? recap.data : null;
  const pending = recap.data && isRecapPending(recap.data) ? recap.data : null;
  const current = date || recap.data?.date || "";

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PageHeader
        title={zh ? "日志" : "Journal"}
        description={zh ? "每个交易日一份报告：Agent 做了什么、变了什么、依据的证据，以及哪些可以撤回。纽约收盘后 45 分钟生成，默认私密。" : "One report per trading day, covering what the agent did, what changed, the supporting evidence, and what can be undone, generated 45 minutes after the New York close and private by default."}
        actions={
          <AsyncButton variant="outline" size="sm" pending={regen} pendingLabel={zh ? "正在重新生成…" : "Regenerating…"} disabled={!shown} disabledReason={regenBlocked(recap.state, Boolean(pending), zh)} onClick={() => void regenerate()}>
            <RefreshCw aria-hidden="true" />{zh ? "重新生成" : "Regenerate"}
          </AsyncButton>
        }
        className="mb-0"
      />
      <DateControl value={current} latest={!date} onChange={(d) => setDate(d)} />
      {recap.state === "loading" || recap.state === "idle" ? (
        <LoadingBlock shape={<JournalSkeleton />} onRetry={recap.reload} label={zh ? "日志加载中" : "Loading journal"} />
      ) : recap.state === "error" ? (
        <ErrorState status={recap.status ?? 0} requestId={requestIdOf(recap.errorBody)} onRetry={recap.reload} title={zh ? "日志没有取到" : "Could not load the journal"} />
      ) : pending ? (
        <PendingDay p={pending} onPrev={(d) => setDate(d)} />
      ) : shown ? (
        <JournalDay r={shown as RecapView} assets={assets} titles={titles} live={live} />
      ) : null}
    </div>
  );
}
