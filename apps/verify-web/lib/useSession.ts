"use client";
/**
 * 网站登录会话（FIX-175）：GET /api/session 返回当前会话里的钱包地址（没登录为 null）。
 * v8 的钱包门用它：钱包连上但还没签登录消息时，先给「签一条登录消息」这一步，
 * 不让页面提前发 owner 请求（否则每页一串 401，服务器 10/3 回执）。
 * 登录 / 退出后 lib/session 会发 `verify:session` 事件，这里据此重读。
 */
import { useEffect, useState } from "react";

export function useSessionAddress(): { address: string | null; checked: boolean } {
  const [address, setAddress] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    let alive = true;
    const read = () => {
      fetch("/api/session", { method: "GET", cache: "no-store", credentials: "same-origin" })
        .then((r) => (r.ok ? (r.json() as Promise<{ address?: string | null }>) : { address: null }))
        .catch(() => ({ address: null }))
        .then((d) => {
          if (!alive) return;
          setAddress(typeof d.address === "string" ? d.address.toLowerCase() : null);
          setChecked(true);
        });
    };
    read();
    window.addEventListener("verify:session", read);
    return () => { alive = false; window.removeEventListener("verify:session", read); };
  }, []);
  return { address, checked };
}
