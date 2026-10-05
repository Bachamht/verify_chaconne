"use client";
/**
 * 控制台数据（从 TaskDetail 搬来，行为不变）：任务视图 + 成交回执（mandates.steps，b41ede7 的 stepRecords 修复由 normalizeMandate 保证）
 * + Agent 意图；15 s 轮询（页面隐藏暂停，useResource）；?v7fixture=1 走固定样例。
 */
import { useCallback, useEffect, useState } from "react";
import { agentTasks, mandates, notReady, type AgentTradeIntent, type TaskCreated } from "@/lib/api-v2";
import { loadAssets, type AssetEntry } from "@/lib/assets";
import { useAccount } from "@/lib/useAccount";
import { useResource } from "@/lib/useResource";
import { v7FixtureRequested } from "@/lib/v7";
import { fxTaskView } from "@/lib/v7fixtures";
import { FIXTURE_ASSETS } from "../task-form/useTradableAssets";

export interface Fill { mandateId: string; stepIndex: string; state: string; txHash: string | null; spent: string | null; received: string | null }
export interface ConsoleData { view: TaskCreated; fills: Fill[]; intents: AgentTradeIntent[] | null }

export function useFixtureFlag(): boolean {
  const [fixture] = useState(() => typeof window !== "undefined" && v7FixtureRequested(window.location.search));
  return fixture;
}

export function useAssetsList(fixture = false): AssetEntry[] {
  const [assets, setAssets] = useState<AssetEntry[]>([]);
  useEffect(() => {
    if (fixture) return;
    let active = true;
    void loadAssets().then((r) => { if (active) setAssets(r.assets); });
    return () => { active = false; };
  }, [fixture]);
  return fixture ? FIXTURE_ASSETS : assets;
}

async function loadFills(view: TaskCreated): Promise<Fill[]> {
  if (view.task.mandateIds.length === 0) return [];
  const views = await Promise.all(view.task.mandateIds.map((m) => mandates.get(m).catch(() => null)));
  return views.flatMap((v) => (v && v.status === 200 ? v.data.steps
    .filter((s) => s.txHash || s.state === "SUBMITTED" || s.state === "CONFIRMED")
    .map((s) => {
      const ev = (s.receipt as { event?: { spent?: string; received?: string } } | null)?.event;
      return { mandateId: v.data.mandateId, stepIndex: s.stepIndex, state: s.state, txHash: s.txHash, spent: ev?.spent ?? null, received: ev?.received ?? null };
    }) : []));
}

export function useTaskConsoleData(id: string) {
  const account = useAccount();
  const fixture = useFixtureFlag();
  const fetcher = useCallback(async (): Promise<{ status: number; data: ConsoleData }> => {
    if (fixture) {
      const sim = new URLSearchParams(window.location.search).get("mode") === "sim";
      return { status: 200, data: { view: fxTaskView(sim ? "SIMULATION" : "LIVE"), intents: null, fills: sim ? [] : [{ mandateId: "mdt_fx_buy", stepIndex: "0", state: "CONFIRMED", txHash: `0x${"a".repeat(64)}`, spent: "2000000", received: null }] } };
    }
    const r = await agentTasks.get(id, account).catch(() => null);
    if (!r || r.status === 0) return { status: 0, data: null as unknown as ConsoleData };
    if (notReady(r) || r.status !== 200) return { status: r.status, data: r.data as unknown as ConsoleData };
    // 意图与成交回执互不依赖：并行（perf async-parallel）
    const [li, fills] = await Promise.all([
      r.data.task.scope ? agentTasks.intents(id, account).catch(() => null) : Promise.resolve(null),
      loadFills(r.data),
    ]);
    return { status: 200, data: { view: r.data, fills, intents: li && li.status === 200 ? li.data.intents : null } };
  }, [id, account, fixture]);
  const res = useResource<ConsoleData>(`task:${id}:${account ?? ""}:${fixture}`, fetcher, { intervalMs: fixture ? null : 15_000 });
  return { res, fixture, account };
}
