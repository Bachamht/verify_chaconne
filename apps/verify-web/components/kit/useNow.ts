"use client";
import { useEffect, useState } from "react";

/**
 * 共享时钟：相对时间与倒计时按 intervalMs 刷新；首帧返回 null（服务端与客户端一致，防水合不一致 E4）。
 * 后台刷新不触发动画（D3）——这里只换文字。
 */
export function useNow(intervalMs = 30_000): Date | null {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
