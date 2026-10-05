"use client";
/**
 * /developers（v8，方案 §5.10）：左目录 + 内容区 Tabs（REST / A2MCP / MCP / SDK / 合约，?tab= 写 URL）。
 * 营销壳；只用 kit + shadcn，不引 lib/api、lib/wallet（D6：开发者页不加载 viem）。
 */
import { Suspense, useEffect, useState } from "react";
import { PageHeader } from "@/components/kit/PageHeader";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useI18n } from "@/lib/i18n";
import { useQueryState } from "@/lib/useQueryState";
import { ContractsTab } from "./ContractsTab";
import { DevToc } from "./DevToc";
import { DEV_TABS, SECTIONS, TAB_LABEL, isDevTab, tabFor, type DevTab } from "./devNav";
import { A2mcpTab, McpTab, SdkTab } from "./ProtocolTabs";
import { RestTab } from "./RestTab";

const LINK = "text-brand-400 underline underline-offset-2 hover:text-brand-300";

function DevelopersBody() {
  const { t, locale } = useI18n();
  const zh = locale === "zh";
  const [rawTab, setTab] = useQueryState("tab", "rest");
  const tab: DevTab = isDevTab(rawTab) ? rawTab : "rest";
  const [current, setCurrent] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  // 旧链接 /developers#v6 仍然有效：按锚点切 tab 再滚动
  useEffect(() => {
    const id = window.location.hash.replace(/^#/, "");
    if (id && SECTIONS.some((s) => s.id === id)) {
      setTab(tabFor(id));
      setCurrent(id);
      setPending(id);
    }
    // 只在首次进入时读锚点
  }, []);

  useEffect(() => {
    if (!pending) return;
    const el = document.getElementById(pending);
    if (el) { el.scrollIntoView({ block: "start" }); setPending(null); }
  }, [pending, tab]);

  function pick(id: string) {
    setTab(tabFor(id));
    setCurrent(id);
    setPending(id);
  }

  return (
    <>
      <PageHeader
        title={t("dev_h")}
        description={<>{zh ? "机器可读的入口：" : "Machine-readable entry points: "}<a className={`${LINK} font-mono`} href="/openapi.json">/openapi.json</a> · <a className={`${LINK} font-mono`} href="/llms.txt">/llms.txt</a> · <a className={`${LINK} font-mono`} href="/.well-known/agent-card.json">/.well-known/agent-card.json</a>{zh ? "（描述全部端点、哪些免 key、怎么调用）。" : " (every endpoint, which ones need no key, how to call)."}</>}
      />
      <div className="grid min-w-0 gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
        <DevToc tab={tab} current={current} onPick={pick} />
        <div className="flex min-w-0 flex-col gap-4">
          <Tabs value={tab} onValueChange={(v) => { setTab(v); setCurrent(null); }} className="min-w-0 gap-4">
            <TabsList variant="line" className="w-full justify-start overflow-x-auto border-b sm:w-fit sm:border-0" aria-label={zh ? "接入方式" : "Integration"}>
              {DEV_TABS.map((k) => <TabsTrigger key={k} value={k} className="flex-none px-3">{TAB_LABEL[k][locale]}</TabsTrigger>)}
            </TabsList>
            <TabsContent value="rest"><RestTab /></TabsContent>
            <TabsContent value="a2mcp"><A2mcpTab /></TabsContent>
            <TabsContent value="mcp"><McpTab /></TabsContent>
            <TabsContent value="sdk"><SdkTab /></TabsContent>
            <TabsContent value="contracts"><ContractsTab /></TabsContent>
          </Tabs>
        </div>
      </div>
    </>
  );
}

export function DevelopersPage() {
  return (
    <Suspense fallback={null}>
      <DevelopersBody />
    </Suspense>
  );
}
