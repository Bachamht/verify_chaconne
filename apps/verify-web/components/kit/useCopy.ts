"use client";
/**
 * 复制到剪贴板：成功 toast + 1.5 秒「已复制」勾；失败提示手动选择。Hash / CodeBlock / 页头钱包按钮共用。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { useI18n } from "@/lib/i18n";

export function useCopy(okText?: { zh: string; en: string }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = useCallback(async (text: string): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.success(okText ? okText[zh ? "zh" : "en"] : zh ? "已复制" : "Copied");
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
      return true;
    } catch {
      toast.error(zh ? "复制失败，请手动选择文本" : "Copy failed. Select the text manually.");
      return false;
    }
  }, [okText, zh]);
  return { copied, copy };
}
