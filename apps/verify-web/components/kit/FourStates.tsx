"use client";
import { useEffect, useState, type ReactNode } from "react";
import { CircleAlert, Inbox, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { Hash } from "./Hash";

/** fetch 10 s 出「还在加载 · 重试」（C2）；30 s 硬超时由 lib/api 负责 */
const SLOW_MS = 10_000;
/** 骨架延迟 150 ms 再出现，避免快请求闪一下 */
const SHOW_AFTER_MS = 150;

function useElapsed(ms: number): boolean {
  const [done, setDone] = useState(false);
  useEffect(() => {
    const id = setTimeout(() => setDone(true), ms);
    return () => clearTimeout(id);
  }, [ms]);
  return done;
}

/**
 * 加载态：与最终布局等形的骨架（shape 由调用方给，默认几行表格行）。
 * 10 s 后补一行「还在加载 · 重试」。aria-live 让读屏知道在加载。
 */
export function LoadingBlock({ shape, rows = 3, onRetry, label, className }: {
  shape?: ReactNode;
  rows?: number;
  onRetry?: () => void;
  label?: string;
  className?: string;
}) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const visible = useElapsed(SHOW_AFTER_MS);
  const slow = useElapsed(SLOW_MS);
  return (
    <div className={cn("min-w-0", className)} role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">{label ?? (zh ? "加载中" : "Loading")}</span>
      <div className={cn("transition-opacity duration-200", visible ? "opacity-100" : "opacity-0")} aria-hidden="true">
        {shape ?? <SkeletonRows rows={rows} />}
      </div>
      {slow ? (
        <p className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 text-sm leading-6 text-fg-2">
          {zh ? "还在加载，比平时慢。" : "Still loading. This is slower than usual."}
          {onRetry ? <Button variant="link" size="sm" className="h-auto p-0" onClick={onRetry}>{zh ? "重试" : "Retry"}</Button> : null}
        </p>
      ) : null}
    </div>
  );
}

/** 表格 / 列表的等形骨架：固定行高 44 */
export function SkeletonRows({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("flex flex-col divide-y divide-line", className)}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex h-11 items-center gap-4">
          <Skeleton className="h-3.5 w-2/5" />
          <Skeleton className="ml-auto h-3.5 w-16" />
          <Skeleton className="h-3.5 w-12" />
        </div>
      ))}
    </div>
  );
}

/**
 * 空状态：图标（或 ≤120px 吉祥物，via art）+ 一句原因 + 一个动作。
 * 写清是「真的没有」还是「没拿到」——没拿到请用 ErrorState。
 */
export function EmptyState({ title, description, action, art, className, size = "md" }: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  art?: ReactNode;
  className?: string;
  size?: "sm" | "md";
}) {
  return (
    <div role="status" className={cn("ch-empty-state flex min-w-0 flex-col items-center text-center", size === "sm" ? "gap-2.5 px-3 py-7" : "gap-4 px-5 py-12 sm:py-16", className)}>
      {art ? <div className={size === "sm" ? "mb-1" : "mb-2"}>{art}</div> : (
        <span className={cn("flex items-center justify-center border border-line bg-surface-2/50 text-fg-3", size === "sm" ? "mb-1 size-10 rounded-md" : "mb-2 size-14 rounded-lg")}>
          <Inbox className={size === "sm" ? "size-5" : "size-6"} strokeWidth={1.5} aria-hidden="true" />
        </span>
      )}
      <p className={cn("max-w-lg font-medium tracking-tight text-fg-1", size === "sm" ? "text-sm leading-6" : "text-title")}>{title}</p>
      {description ? <p className="max-w-md text-sm leading-7 text-fg-2">{description}</p> : null}
      {action ? <div className={cn("flex max-w-full flex-wrap justify-center gap-3", size === "sm" ? "mt-1" : "mt-3")}>{action}</div> : null}
    </div>
  );
}

/** 错误态：一句人话 + 修法（重试 / 稍后）+ requestId（可复制）。不用 "Oops"、不道歉 */
export function ErrorState({ title, description, onRetry, requestId, status, className, size = "md" }: {
  title?: ReactNode;
  description?: ReactNode;
  onRetry?: () => void;
  requestId?: string | null;
  /** HTTP 状态码；0 / undefined = 超时或网络错误 */
  status?: number;
  className?: string;
  size?: "sm" | "md";
}) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const timedOut = !status;
  const fallbackTitle = timedOut ? (zh ? "没有拿到服务的回应" : "No response from the service") : status! >= 500 ? (zh ? "服务暂时出错" : "The service hit an error") : status === 404 ? (zh ? "没有找到" : "Not found") : (zh ? "请求被拒绝" : "The request was refused");
  const fallbackDesc = timedOut ? (zh ? "可能是网络断开、超时或服务繁忙。检查网络后重试。" : "The network may be down, the request timed out, or the service is busy. Check your connection and retry.") : status! >= 500 ? (zh ? "不是你的操作问题。稍后重试；一直出现请把下面的编号发给我们。" : "Not caused by anything you did. Retry shortly; if it persists, send us the ID below.") : (zh ? "检查钱包是否连接正确，或刷新后重试。" : "Check that the right wallet is connected, or refresh and retry.");
  return (
    <div role="alert" className={cn("ch-error-state flex min-w-0 items-start text-left", size === "sm" ? "gap-3 px-3 py-5" : "gap-4 px-4 py-9 sm:gap-5 sm:px-6", className)}>
      <span className={cn("flex shrink-0 items-center justify-center rounded-md border border-bad/20 bg-bad/8 text-bad", size === "sm" ? "size-8" : "size-10")}><CircleAlert className={size === "sm" ? "size-4" : "size-5"} strokeWidth={1.5} aria-hidden="true" /></span>
      <div className="min-w-0 flex-1 pt-0.5">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <p className={cn("font-medium text-fg-1", size === "sm" ? "text-sm leading-6" : "text-md")}>{title ?? fallbackTitle}</p>
          {status ? <span className="font-mono text-xs text-fg-3 tabular-nums">{zh ? `错误码 ${status}` : `Code ${status}`}</span> : null}
        </div>
        <p className={cn("mt-2 max-w-xl text-sm text-fg-2", size === "sm" ? "leading-6" : "leading-7")}>{description ?? fallbackDesc}</p>
        {onRetry || requestId ? <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-3">
          {onRetry ? <Button variant="outline" size="sm" onClick={onRetry}><RefreshCw aria-hidden="true" />{zh ? "重试" : "Retry"}</Button> : null}
          {requestId ? <span className="inline-flex max-w-full flex-wrap items-center gap-1.5 text-xs text-fg-3">{zh ? "编号" : "Request ID"} <Hash value={requestId} kind="id" /></span> : null}
        </div> : null}
      </div>
    </div>
  );
}
