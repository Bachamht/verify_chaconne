"use client";
/**
 * 深链动作：别的页面（日志「需要你决定」、今天页）用 `?do=revoke|cancel|delegate|decide` 把人带到任务页时，数据就绪后直接打开对应的确认框（delegate = 打开委托签名面板；decide = 「继续还是取消」）。
 * 只打开，不替用户确认；用过一次就从地址栏去掉，刷新不会再弹。
 */
import { useEffect, useRef } from "react";

export type DeepAction = "revoke" | "cancel" | "delegate" | "decide";
const OPS: readonly string[] = ["revoke", "cancel", "delegate", "decide"];

export function deepActionHref(path: string, op: DeepAction): string {
  return `${path}?do=${op}`;
}

/** open(op) 返回 true 表示确认框已打开；数据还没到、暂时做不了时返回 false，下次渲染再试 */
export function useDeepAction(open: (op: DeepAction) => boolean): void {
  const done = useRef(false);
  useEffect(() => {
    if (done.current || typeof window === "undefined") return;
    const url = new URL(window.location.href);
    const op = url.searchParams.get("do");
    if (!op || !OPS.includes(op)) return;
    if (!open(op as DeepAction)) return;
    done.current = true;
    url.searchParams.delete("do");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
  });
}
