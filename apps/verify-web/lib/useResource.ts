"use client";
/**
 * v8 数据区块的统一取数（四态 + 轮询，perf-rules「client-swr-dedup」的轻量版，不引新依赖）：
 *  - state：loading（首次）/ ok / empty / error；后台刷新不回到 loading（不闪，D3）
 *  - status 0 = 30 s 超时或网络错误（lib/api 的约定）；其它非 2xx 原样给 ErrorState
 *  - intervalMs：页面隐藏时暂停，回到前台立即刷新一次
 *  - key 变化（换任务 / 换钱包）时丢弃旧数据与在途响应
 * 用法：const r = useResource(account ? `tasks:${account}` : null, () => agentTasks.list(account!), { isEmpty: (d) => d.tasks.length === 0, intervalMs: 15_000 });
 */
import { useCallback, useEffect, useRef, useState } from "react";

export interface ApiResult<T> { status: number; data: T }
export type ResourceState = "idle" | "loading" | "ok" | "empty" | "error";
export interface Resource<T> {
  state: ResourceState;
  data: T | null;
  /** 最近一次失败的 HTTP 状态（0 = 超时 / 网络） */
  status: number | null;
  /** 最近一次失败的响应体（给 apiError / requestId 用） */
  errorBody: unknown;
  /** 后台刷新进行中（首屏之后） */
  refreshing: boolean;
  /** 最近一次成功的时间（「更新于」） */
  updatedAt: Date | null;
  reload: () => void;
}

export function useResource<T>(
  key: string | null,
  fetcher: () => Promise<ApiResult<T>>,
  opts: { intervalMs?: number | null; isEmpty?: (d: T) => boolean; ok?: (status: number) => boolean } = {},
): Resource<T> {
  const [state, setState] = useState<ResourceState>(key ? "loading" : "idle");
  const [data, setData] = useState<T | null>(null);
  const [status, setStatus] = useState<number | null>(null);
  const [errorBody, setErrorBody] = useState<unknown>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const gen = useRef(0);
  const hasData = useRef(false);
  /** 在途请求：轮询不叠加（15 s 间隔、30 s 超时时会叠）；手动 reload 也共用它 */
  const inFlight = useRef<Promise<void> | null>(null);
  const keyRef = useRef(key);
  keyRef.current = key;

  const run = useCallback((g: number): Promise<void> => {
    if (inFlight.current) return inFlight.current;
    const p = runOnce(g).finally(() => { if (inFlight.current === p) inFlight.current = null; });
    inFlight.current = p;
    return p;
  }, []);

  async function runOnce(g: number): Promise<void> {
    if (hasData.current) setRefreshing(true);
    let r: ApiResult<T> | null = null;
    try {
      r = await fetcherRef.current();
    } catch {
      r = { status: 0, data: null as T };
    }
    if (g !== gen.current) return;
    setRefreshing(false);
    const ok = optsRef.current.ok ? optsRef.current.ok(r.status) : r.status >= 200 && r.status < 300;
    if (ok) {
      hasData.current = true;
      setData(r.data);
      setStatus(null);
      setErrorBody(null);
      setUpdatedAt(new Date());
      setState(optsRef.current.isEmpty?.(r.data) ? "empty" : "ok");
    } else {
      setStatus(r.status);
      setErrorBody(r.data);
      // 已有数据时刷新失败不清空画面，只记录状态（调用方可显示「更新失败」）
      if (!hasData.current) setState("error");
    }
  }

  useEffect(() => {
    gen.current += 1;
    hasData.current = false;
    setData(null);
    setStatus(null);
    setErrorBody(null);
    setUpdatedAt(null);
    inFlight.current = null;
    if (!key) { setState("idle"); return; }
    setState("loading");
    void run(gen.current);
  }, [key, run]);

  useEffect(() => {
    const ms = opts.intervalMs;
    if (!key || !ms) return;
    let id: ReturnType<typeof setInterval> | null = null;
    const start = () => { if (!id) id = setInterval(() => void run(gen.current), ms); };
    const stop = () => { if (id) { clearInterval(id); id = null; } };
    const onVis = () => {
      if (document.hidden) stop();
      else { void run(gen.current); start(); }
    };
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVis);
    return () => { stop(); document.removeEventListener("visibilitychange", onVis); };
  }, [key, opts.intervalMs, run]);

  const reload = useCallback(() => {
    if (!keyRef.current) return;
    if (!hasData.current) setState("loading");
    void run(gen.current);
  }, [run]);

  return { state, data, status, errorBody, refreshing, updatedAt, reload };
}

/** 从错误响应体里取 requestId（服务端字段名不一，按常见几种找） */
export function requestIdOf(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  for (const k of ["requestId", "request_id", "traceId", "id"]) if (typeof b[k] === "string") return b[k] as string;
  return null;
}
