"use client";
import type { ReactNode } from "react";
import { ChevronRight, Clock3, Database, FileJson2 } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { useI18n } from "@/lib/i18n";
import { evidenceMode } from "@/lib/status";
import { cn } from "@/lib/utils";
import { CodeBlock } from "./CodeBlock";
import { Hash } from "./Hash";
import { ModeTag } from "./StatusBadge";
import { Timestamp } from "./Timestamp";

/**
 * 证据面板（复合组件）：
 * <EvidencePanel>
 *   <EvidencePanel.Header title="报价与依据" count={7} />
 *   <EvidencePanel.Item source="okx-dex · aggregator/quote" at={iso} mode="LIVE" hash="0x…">值</EvidencePanel.Item>
 *   <EvidencePanel.Raw json={…} />
 * </EvidencePanel>
 * 每条 = 来源 + Timestamp(abs) + 模式标签（永远可见）+ Hash；原始 JSON 只在 Raw，默认折叠。
 */
function Root({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cn("ch-evidence-panel flex min-w-0 flex-col overflow-hidden rounded-lg border border-line bg-card", className)}>{children}</section>;
}

function Header({ title, count, description, action }: { title: ReactNode; count?: number; description?: ReactNode; action?: ReactNode }) {
  return (
    <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line/80 px-5 py-5">
      <div className="min-w-0 flex-1">
        <h3 className="flex flex-wrap items-center gap-2.5 text-md font-medium text-fg-1">
          {title}
          {typeof count === "number" ? <span className="inline-flex min-w-6 items-center justify-center rounded-sm border border-line px-1.5 py-0.5 font-mono text-xs font-normal text-fg-3 tabular-nums">{count}</span> : null}
        </h3>
        {description ? <p className="mt-2 max-w-xl text-sm leading-6 text-fg-2">{description}</p> : null}
      </div>
      {action}
    </header>
  );
}

function Item({ source, at, mode, hash, hashKind = "id", children }: {
  source: ReactNode;
  at?: string | number | null;
  mode?: string | null;
  hash?: string | null;
  hashKind?: "tx" | "hash" | "id" | "address";
  children?: ReactNode;
}) {
  const m = evidenceMode(mode);
  return (
    <div className="ch-evidence-item min-w-0 border-b border-line/70 px-5 py-4 last:border-b-0">
      <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-1 items-start gap-2.5">
          <Database className="mt-1 size-3.5 shrink-0 text-fg-3" strokeWidth={1.5} aria-hidden="true" />
          <p className="min-w-0 text-sm leading-6 font-medium break-words text-fg-1" title={typeof source === "string" ? source : undefined}>{source}</p>
        </div>
        {children ? <div className="min-w-0 max-w-full text-sm leading-6 font-medium break-words text-fg-1 sm:max-w-1/2 sm:text-right">{children}</div> : null}
      </div>
      <div className="mt-2.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 text-xs text-fg-3">
        {m ? <ModeTag mode={m} /> : null}
        {at ? <span className="inline-flex items-center gap-1.5"><Clock3 className="size-3 shrink-0" strokeWidth={1.5} aria-hidden="true" /><Timestamp at={at} mode="abs" /></span> : null}
        {hash ? <Hash value={hash} kind={hashKind} className="max-w-full" /> : null}
      </div>
    </div>
  );
}

function Raw({ json, label }: { json: unknown; label?: ReactNode }) {
  const { locale } = useI18n();
  const text = typeof json === "string" ? json : JSON.stringify(json, null, 2);
  return (
    <Collapsible className="border-t border-line/80 bg-surface-0/30">
      <CollapsibleTrigger className="group flex w-full items-center gap-2.5 px-5 py-3.5 text-left text-xs text-fg-3 transition-colors hover:bg-surface-2/30 hover:text-fg-1">
        <FileJson2 className="size-4 shrink-0" strokeWidth={1.5} aria-hidden="true" />
        <span className="min-w-0 flex-1">{label ?? (locale === "zh" ? "原始数据（开发者）" : "Raw data (developers)")}</span>
        <ChevronRight className="size-3.5 shrink-0 transition-transform duration-200 group-data-[state=open]:rotate-90" aria-hidden="true" />
      </CollapsibleTrigger>
      <CollapsibleContent className="px-5 pt-1 pb-5">
        <CodeBlock code={text} language="json" />
      </CollapsibleContent>
    </Collapsible>
  );
}

export const EvidencePanel = Object.assign(Root, { Header, Item, Raw });
