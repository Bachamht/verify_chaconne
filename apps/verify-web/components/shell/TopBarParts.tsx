"use client";
/** 两种壳共用的顶栏小件：语言切换、证据模式 / 网络灯。都不依赖钱包代码（营销页 D6）。 */
import { useEffect, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { CHAIN_ID_PUBLIC } from "@/lib/explorer";
import { publicGet } from "@/lib/publicApi";
import { cn } from "@/lib/utils";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

export function LanguageToggle({ className }: { className?: string }) {
  const { locale, setLocale } = useI18n();
  return (
    <button
      type="button"
      onClick={() => setLocale(locale === "en" ? "zh" : "en")}
      aria-label={locale === "en" ? "切换到中文" : "Switch to English"}
      className={cn("inline-flex h-8 min-w-10 items-center justify-center rounded-md px-2 text-xs font-medium text-fg-2 hover:bg-surface-2 hover:text-fg-1", className)}
    >
      {locale === "en" ? "中文" : "EN"}
    </button>
  );
}

type Mode = "LIVE" | "FIXTURE" | null;

/** 证据模式 + 网络灯：全局状态只在页头出现一次（B6） */
export function StatusLight({ className }: { className?: string }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const [mode, setMode] = useState<Mode>(null);
  const [down, setDown] = useState(false);
  useEffect(() => {
    let alive = true;
    void publicGet<{ evidenceMode?: "LIVE" | "FIXTURE" }>("v1/assets").then((r) => {
      if (!alive) return;
      if (r.status === 200) { if (r.data?.evidenceMode) setMode(r.data.evidenceMode); }
      else setDown(true);
    });
    return () => { alive = false; };
  }, []);
  const tone = down ? "bg-bad" : mode === "LIVE" ? "bg-ok" : mode === "FIXTURE" ? "bg-warn" : "bg-fg-3";
  const label = down ? (zh ? "服务未响应" : "Service unreachable") : mode === "LIVE" ? (zh ? "实时证据" : "Live evidence") : mode === "FIXTURE" ? (zh ? "示例数据" : "Fixture data") : (zh ? "检查中" : "Checking");
  const network = CHAIN_ID_PUBLIC === 196 ? "X Layer" : `X Layer Testnet · ${CHAIN_ID_PUBLIC}`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className={cn("inline-flex h-8 items-center gap-2 rounded-md px-2 text-xs text-fg-2", className)} tabIndex={0} role="status">
          <span className={cn("size-2 rounded-full", tone)} aria-hidden="true" />
          <span className="hidden lg:inline">{label}</span>
          <span className="hidden text-fg-3 xl:inline">· {network}</span>
          <span className="sr-only lg:hidden">{label} · {network}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label} · {network}</TooltipContent>
    </Tooltip>
  );
}
