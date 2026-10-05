"use client";
import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { SECTIONS, TAB_LABEL, type DevTab } from "./devNav";

/**
 * 左目录：桌面 sticky 竖排；手机收进顶部 Collapsible（不占首屏）。
 * 点一节 = 切到它所在的 tab 并滚到那一节（onPick 由页面处理）。
 */
export function DevToc({ tab, current, onPick }: { tab: DevTab; current: string | null; onPick: (id: string) => void }) {
  const { locale } = useI18n();
  const zh = locale === "zh";
  const [open, setOpen] = useState(false);
  const list = (
    <ul className="flex flex-col gap-0.5">
      {SECTIONS.map((s) => {
        const active = current === s.id;
        return (
          <li key={s.id}>
            <a
              href={`#${s.id}`}
              onClick={(e) => { e.preventDefault(); setOpen(false); onPick(s.id); }}
              aria-current={active ? "location" : undefined}
              className={cn(
                "flex h-8 items-center justify-between gap-2 rounded-md border-l-2 px-2 text-sm hover:bg-surface-2 hover:text-fg-1",
                active ? "border-brand-400 text-fg-1" : "border-transparent",
                !active && (s.tab === tab ? "text-fg-1" : "text-fg-2"),
              )}
            >
              <span className="truncate">{zh ? s.zh : s.en}</span>
              <span className="shrink-0 text-xs text-fg-3">{TAB_LABEL[s.tab][locale]}</span>
            </a>
          </li>
        );
      })}
    </ul>
  );
  const keyHint = (
    <p className="mt-3 text-xs leading-5 text-fg-3">
      {zh ? <>写操作与私密读取需要 key：在 <a className="text-brand-400 underline underline-offset-2 hover:text-brand-300" href="/agent/keys">Agent 接入 key</a> 用钱包签一条消息生成，请求头 x-api-key。</> : <>Writes and private reads need a key: issue one with a wallet signature under <a className="text-brand-400 underline underline-offset-2 hover:text-brand-300" href="/agent/keys">Agent API keys</a>, send it as x-api-key.</>}
    </p>
  );
  return (
    <>
      <nav className="sticky top-20 hidden self-start lg:block" aria-label={zh ? "开发者页目录" : "Developers page contents"}>
        <p className="mb-2 px-2 text-xs font-medium tracking-wide text-fg-3 uppercase">{zh ? "目录" : "Contents"}</p>
        {list}
        <div className="px-2">{keyHint}</div>
      </nav>
      <Collapsible open={open} onOpenChange={setOpen} className="rounded-lg border bg-card lg:hidden">
        <CollapsibleTrigger className="flex h-11 w-full items-center justify-between px-4 text-sm font-medium text-fg-1">
          {zh ? "目录" : "Contents"}
          <ChevronDown className={cn("size-4 text-fg-2 transition-transform duration-200", open && "rotate-180")} aria-hidden="true" />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <nav className="border-t px-2 py-2" aria-label={zh ? "开发者页目录" : "Developers page contents"}>
            {list}
            <div className="px-2 pb-1">{keyHint}</div>
          </nav>
        </CollapsibleContent>
      </Collapsible>
    </>
  );
}
