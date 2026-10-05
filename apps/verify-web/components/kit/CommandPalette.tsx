"use client";
import dynamic from "next/dynamic";
import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const Dialog = dynamic(() => import("./CommandPaletteDialog"), { ssr: false });

/**
 * ⌘K / Ctrl+K：跳页面、常用动作。触发按钮常驻页头；cmdk 延迟到第一次打开才加载。
 */
export function CommandPalette({ className }: { className?: string }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [mac, setMac] = useState(false);
  useEffect(() => {
    setMac(/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent));
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setLoaded(true);
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return (
    <>
      <button
        type="button"
        onClick={() => { setLoaded(true); setOpen(true); }}
        className={cn("inline-flex h-8 min-w-0 items-center gap-2 rounded-md border border-line-strong bg-surface-1 px-2.5 text-sm text-fg-3 hover:border-brand-400 hover:text-fg-2", className)}
        aria-label={zh ? "搜索与跳转（⌘K）" : "Search and jump (⌘K)"}
      >
        <Search className="size-4 shrink-0" aria-hidden="true" />
        <span className="hidden truncate md:inline">{zh ? "搜索或跳转" : "Search or jump"}</span>
        <kbd className="ml-auto hidden rounded-sm border border-line px-1.5 font-mono text-xs text-fg-3 md:inline">{mac ? "⌘K" : "Ctrl K"}</kbd>
      </button>
      {loaded ? <Dialog open={open} onOpenChange={setOpen} /> : null}
    </>
  );
}
