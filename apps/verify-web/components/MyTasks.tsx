"use client";
/** /me · 我的记录：这个钱包名下的全部记录（计划任务 / 授权计划 / 规划 / 单笔核验 / 模拟），来自 GET /v1/records?owner=；没有本机存储。 */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { records, notReady, type RecordItem } from "@/lib/api-v2";
import { apiError } from "@/lib/errors";
import { formatAmount, formatTime } from "@/lib/format";
import { loadAssets, type AssetEntry } from "@/lib/assets";
import { WalletGate } from "@/components/WalletGate";
import { Card, EmptyState, Pill } from "@/components/ui";
import { LoadingState, NotReady, Skeleton } from "@/components/agent/shared";
import { playbookTitle, statusLabel } from "@/components/agent/tasks/taskTitle";

const KIND_TONE: Record<RecordItem["kind"], "ok" | "warn" | "brand" | "neutral" | "info"> = { task: "brand", mandate: "warn", plan: "info", job: "ok", simulation: "neutral" };

export function hrefOf(item: RecordItem): string {
  switch (item.kind) {
    case "task": return `/agent/tasks/${encodeURIComponent(item.id)}`;
    case "mandate": return `/tasks/${encodeURIComponent(item.id)}`;
    case "plan": return `/plan?plan=${encodeURIComponent(item.id)}`;
    case "job": return `/jobs/${encodeURIComponent(item.id)}`;
    case "simulation": return `/play?simulation=${encodeURIComponent(item.id)}`;
  }
}

export function MyTasks() {
  const { locale } = useI18n();
  const zh = locale === "zh";
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">{zh ? "我的记录" : "My records"}</h1>
      <p className="text-sm text-fg-2">{zh ? "这个钱包名下的计划任务、授权计划、规划、单笔核验与模拟，按时间倒序。换一个钱包就看到另一个账户的记录。" : "Tasks, authorizations, plans, single verifications and simulations under this wallet, newest first. Switch wallets to see another account."}</p>
      <WalletGate compact>{(account) => <RecordsList account={account} />}</WalletGate>
    </div>
  );
}

function RecordsList({ account }: { account: string }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const [assets, setAssets] = useState<AssetEntry[]>([]);
  const [state, setState] = useState<{ kind: "busy" } | { kind: "nr"; http: number } | { kind: "err"; msg: string } | { kind: "ok"; items: RecordItem[] }>({ kind: "busy" });
  const [seq, setSeq] = useState(0);
  const reload = useCallback(() => setSeq((n) => n + 1), []);
  useEffect(() => { void loadAssets().then((r) => setAssets(r.assets)); }, []);
  useEffect(() => {
    let alive = true;
    setState({ kind: "busy" });
    records.list(account.toLowerCase()).then((r) => {
      if (!alive) return;
      if (r.status === 0 || notReady(r)) setState({ kind: "nr", http: r.status });
      else if (r.status !== 200) setState({ kind: "err", msg: apiError(r, locale) });
      else setState({ kind: "ok", items: r.data.items });
    }).catch(() => alive && setState({ kind: "nr", http: 0 }));
    return () => { alive = false; };
  }, [account, locale, seq]);
  const sym = (key?: string) => (key ? assets.find((a) => a.assetKey.toLowerCase() === key.toLowerCase())?.displaySymbol ?? key.slice(-6) : "—");
  const dec = (key?: string) => (key ? assets.find((a) => a.assetKey.toLowerCase() === key.toLowerCase())?.tokenDecimals ?? 6 : 6);
  const kindLabel = (k: RecordItem["kind"]) => ({ task: zh ? "计划任务" : "Agent task", mandate: zh ? "授权计划" : "Authorization", plan: zh ? "规划" : "Plan", job: zh ? "单笔核验" : "Verification", simulation: zh ? "模拟" : "Simulation" })[k];
  const title = (it: RecordItem): string => {
    const outs = (it.outputAssetKeys ?? []).map((k) => sym(k)).join(" + ") || "—";
    const side = it.side === "sell" ? (zh ? "卖出" : "Sell") : (zh ? "买入" : "Buy");
    if (it.kind === "task") {
      const per = typeof it.params?.["perStepAmountRaw"] === "string" ? String(it.params["perStepAmountRaw"]) : typeof it.params?.["amountRaw"] === "string" ? String(it.params["amountRaw"]) : null;
      const steps = typeof it.params?.["steps"] === "number" ? Number(it.params["steps"]) : null;
      const amount = per ? `${formatAmount(per, dec(it.inputAssetKey), sym(it.inputAssetKey))}${steps && steps > 1 ? ` × ${steps}` : ""}` : "";
      return [playbookTitle(it.playbookId ?? "", locale), outs, amount].filter(Boolean).join(" · ");
    }
    if (it.kind === "mandate") return `${zh ? "授权" : "Mandate"} · ${outs} · ${formatAmount(it.budgetCap ?? null, dec(it.inputAssetKey), sym(it.inputAssetKey))} · ${it.stepsDone ?? 0}/${it.maxSteps ?? "?"}`;
    const amount = it.amountInRaw ? formatAmount(it.amountInRaw, dec(it.inputAssetKey), sym(it.inputAssetKey)) : "";
    return [side, outs, amount].filter(Boolean).join(" · ");
  };
  return (
    <Card>
      {state.kind === "busy" && <div className="space-y-2" aria-busy="true"><LoadingState onRetry={reload} /><Skeleton lines={4} /></div>}
      {state.kind === "nr" && <NotReady what="GET /v1/records" status={state.http} onRetry={reload} />}
      {state.kind === "err" && <p className="text-sm text-bad">{state.msg}</p>}
      {state.kind === "ok" && (state.items.length === 0
        ? <EmptyState compact title={zh ? "这个钱包还没有记录" : "No records under this wallet yet"} description={zh ? "先免费模拟一个任务，或者规划一笔交易。" : "Simulate a task for free, or plan a trade."} primary={{ href: "/start", label: zh ? "免费模拟一个任务" : "Simulate a task" }} secondary={{ href: "/agent?entry=buy", label: zh ? "详细创建" : "Advanced setup" }} />
        : <ul className="divide-y divide-line text-sm">
          {state.items.map((it) => (
            <li key={`${it.kind}:${it.id}`} className="flex flex-wrap items-center gap-3 py-2">
              <Pill tone={KIND_TONE[it.kind]}>{kindLabel(it.kind)}</Pill>
              {it.mode === "SIMULATION" && <Pill tone="neutral">{zh ? "模拟" : "Simulation"}</Pill>}
              <Link href={hrefOf(it)} className="min-w-0 flex-1 truncate underline underline-offset-2">{title(it)}</Link>
              {it.status && <span className="text-xs text-fg-2">{it.kind === "task" ? statusLabel(it.status, locale) : it.status}</span>}
              <span className="mono text-xs text-fg-3">{formatTime(it.createdAt, locale)}</span>
            </li>
          ))}
        </ul>)}
    </Card>
  );
}
