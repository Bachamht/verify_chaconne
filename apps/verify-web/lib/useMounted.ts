"use client";
/**
 * 挂载后才为 true。用于「服务端与客户端必然不同」的内容（时区标签、本地时间、随机数）：
 * 服务端与首帧渲染占位，挂载后再渲染真值，避免 React #418 水合不匹配。
 * 服务器验收发现 `/plan` 的「期限 · 本地时间」在任何非 UTC 时区都会报 #418（服务端按 UTC、客户端按浏览器时区）。
 */
import { useEffect, useState } from "react";

export function useMounted(): boolean {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return mounted;
}
