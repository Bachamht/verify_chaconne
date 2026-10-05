"use client";
/**
 * 活动流轮询（P3 / P-04）：GET /v1/tasks/:id/activity?since=<cursor> 增量拉取。
 * 轮次进行中或等成交 3 s 一次，其它 10 s；页面隐藏即停，回到前台立刻补拉一次。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { TaskRuntime } from "@chaconne/core/verify";
import { notReady, v7, type ActivityItem, type ActivityPage } from "@/lib/api-v2";
import { fxActivity, fxRuntime } from "@/lib/v7fixtures";
import { mergeActivity, pollIntervalMs } from "./runtimeModel";

export interface ActivityFeedState {
  items: ActivityItem[];
  runtime: TaskRuntime | null;
  status: "busy" | "ok" | "nr" | "offline";
  http: number;
  intervalMs: number | null;
  hidden: boolean;
  refresh: () => void;
}

interface FeedOptions { fixture?: boolean; mode?: "LIVE" | "SIMULATION"; initialRuntime?: TaskRuntime | null; enabled?: boolean }
type FeedInput = FeedOptions & { taskId: string };
type FeedSnapshot = Pick<ActivityFeedState, "items" | "runtime" | "status" | "http"> & { key: string };
type ActivityResponse = { status: number; data: ActivityPage };
type ActivityLoader = (taskId: string, since: string | number | null) => Promise<ActivityResponse>;

function feedKey(input: FeedInput): string {
  return JSON.stringify([input.taskId, !!input.fixture, input.mode ?? "unknown", input.enabled !== false && !input.fixture]);
}
function initialFeed(input: FeedInput): FeedSnapshot {
  return { key: feedKey(input), items: input.fixture ? fxActivity(input.mode) : [], runtime: input.fixture ? fxRuntime("waiting", input.mode) : input.initialRuntime ?? null, status: input.fixture ? "ok" : "busy", http: 0 };
}

/** 每次 start 都是新会话（包括 A → B → A）；请求、游标和发布权限不跨会话共享。 */
export function createActivityFeedCoordinator(load: ActivityLoader = v7.activity) {
  type Session = { input: FeedInput; value: FeedSnapshot; cursor: string | number | null; active: boolean; pending: Promise<void> | null; received: boolean; publish: (value: FeedSnapshot) => void };
  let current: Session | null = null;
  return {
    start(input: FeedInput, publish: (value: FeedSnapshot) => void) {
      if (current) current.active = false;
      const session: Session = { input, value: initialFeed(input), cursor: null, active: true, pending: null, received: false, publish };
      current = session;
      publish(session.value);
      return () => { session.active = false; if (current === session) current = null; };
    },
    /** 新身份的首帧直接用新初始值，不等待 effect 清理旧任务。 */
    visible(input: FeedInput, value: FeedSnapshot): FeedSnapshot {
      return value.key === feedKey(input) ? value : initialFeed(input);
    },
    seed(key: string, runtime: TaskRuntime | null | undefined) {
      const session = current;
      if (!session?.active || session.value.key !== key || session.input.fixture || session.received || session.value.runtime || !runtime) return;
      session.value = { ...session.value, runtime };
      session.publish(session.value);
    },
    pull(key: string): Promise<void> {
      const session = current;
      if (!session?.active || session.value.key !== key || session.input.fixture || session.input.enabled === false) return Promise.resolve();
      // 手动刷新和轮询共用在途请求，避免同一任务的响应乱序让游标倒退。
      if (session.pending) return session.pending;
      session.pending = (async () => {
        const r = await load(session.input.taskId, session.cursor).catch(() => null);
        if (!session.active || current !== session) return;
        const old = session.value;
        if (!r || r.status === 0) session.value = { ...old, status: old.status === "ok" ? "ok" : "offline", http: 0 };
        else if (notReady(r)) session.value = { ...old, status: "nr", http: r.status };
        else if (r.status !== 200) session.value = { ...old, status: old.status === "ok" ? "ok" : "nr", http: r.status };
        else {
          session.received = true;
          session.cursor = r.data.nextCursor ?? r.data.items.at(-1)?.id ?? session.cursor;
          session.value = { ...old, items: mergeActivity(old.items, r.data.items), runtime: r.data.runtime ?? null, status: "ok", http: 200 };
        }
        session.publish(session.value);
      })().finally(() => { session.pending = null; });
      return session.pending;
    },
  };
}

export function useActivityFeed(taskId: string, opts: FeedOptions = {}): ActivityFeedState {
  const fixture = !!opts.fixture;
  const mode = opts.mode;
  const enabled = opts.enabled !== false && !fixture;
  const input = { taskId, fixture, mode, enabled, initialRuntime: opts.initialRuntime };
  const key = feedKey(input);
  const [coordinator] = useState(() => createActivityFeedCoordinator());
  const [snapshot, setSnapshot] = useState(() => initialFeed(input));
  const { items, runtime, status, http } = coordinator.visible(input, snapshot);
  const [hidden, setHidden] = useState(false);
  const seedRuntime = useRef(opts.initialRuntime);
  useEffect(() => { seedRuntime.current = opts.initialRuntime; }, [opts.initialRuntime]);
  useEffect(() => coordinator.start({ taskId, fixture, mode, enabled, initialRuntime: seedRuntime.current }, setSnapshot), [coordinator, taskId, fixture, mode, enabled]);
  useEffect(() => { coordinator.seed(key, opts.initialRuntime); }, [coordinator, key, opts.initialRuntime]);
  const pull = useCallback(() => coordinator.pull(key), [coordinator, key]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const on = () => setHidden(document.visibilityState === "hidden");
    on();
    document.addEventListener("visibilitychange", on);
    return () => document.removeEventListener("visibilitychange", on);
  }, []);

  const intervalMs = fixture ? null : pollIntervalMs(runtime, hidden);
  const stopped = status === "nr";
  useEffect(() => {
    if (!enabled || intervalMs === null || stopped) return;
    // Initial state stays SSR-safe; do not start even the first request in a hidden tab.
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      await pull();
      if (!stop) timer = setTimeout(tick, intervalMs);
    };
    void tick();
    return () => { stop = true; if (timer) clearTimeout(timer); };
  }, [enabled, intervalMs, pull, stopped]);

  return { items, runtime, status, http, intervalMs, hidden, refresh: () => void pull() };
}
