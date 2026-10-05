"use client";
/**
 * URL 查询参数状态（C5：筛选 / tab / 抽屉 id 写进 URL，刷新可恢复）。
 * 用 router.replace（不新增历史记录、不滚动）；值为 null / "" / 默认值时从 URL 删除。
 * router.replace 不会同步改地址栏：同一事件里连续设两个参数时，后一次要在前一次「待生效」的基础上改，
 * 所以把待生效的查询串记在模块里，等 searchParams 真正变化后清掉。
 */
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect } from "react";

let pending: string | null = null;

export function useQueryState(name: string, defaultValue = ""): [string, (v: string | null) => void] {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const value = params?.get(name) ?? defaultValue;
  const current = params?.toString() ?? "";
  useEffect(() => { pending = null; }, [current]);
  const set = useCallback((v: string | null) => {
    const next = new URLSearchParams(pending ?? (typeof window !== "undefined" ? window.location.search : current));
    if (v === null || v === "" || v === defaultValue) next.delete(name);
    else next.set(name, v);
    const qs = next.toString();
    pending = qs;
    router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
  }, [current, router, pathname, name, defaultValue]);
  return [value, set];
}

/** 一次改多个参数（值为 null / "" 时删除）；与 useQueryState 共用同一个「待生效」查询串，不会互相覆盖。 */
export function useQueryPatch(): (patch: Record<string, string | null>) => void {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const current = params?.toString() ?? "";
  useEffect(() => { pending = null; }, [current]);
  return useCallback((patch: Record<string, string | null>) => {
    const next = new URLSearchParams(pending ?? (typeof window !== "undefined" ? window.location.search : current));
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === "") next.delete(k);
      else next.set(k, v);
    }
    const qs = next.toString();
    pending = qs;
    router.replace(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
  }, [current, router, pathname]);
}
