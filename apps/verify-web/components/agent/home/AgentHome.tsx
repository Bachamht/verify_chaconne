"use client";
/**
 * /agent 首页（上游 §5）：以任务为中心，不堆宏观仪表盘。
 * 顶部四入口 → 引导表单；新用户第一分钟；Crew（只复述真实响应）；今晚的任务；自然语言框（仅当有 Agent）。
 */
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ArrowLeftRight, CalendarSearch, HelpCircle, ShoppingCart } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import type { AssetsResponse } from "@/lib/api";
import { marketContext, marketEvents, type CreateTaskBody } from "@/lib/api-v2";
import { useAccount } from "@/lib/useAccount";
import { Card } from "@/components/ui";
import { Crew } from "../crew/Crew";
import { Missions } from "../crew/Missions";
import { ENTRIES, type EntryId } from "./entries";
import { EntryPanel, loadAssets } from "./EntryForms";
import { FirstMinute } from "./FirstMinute";
import { NlBox } from "./NlBox";

const ICONS = { buy: ShoppingCart, impact: CalendarSearch, wait: HelpCircle, compare: ArrowLeftRight } as const;

export function AgentHome() {
  const { t, locale } = useI18n();
  const zh = locale === "zh";
  const sp = useSearchParams();
  const account = useAccount();
  const [assets, setAssets] = useState<AssetsResponse["assets"]>([]);
  const [entry, setEntry] = useState<EntryId | null>((sp.get("entry") as EntryId | null) && ENTRIES.some((e) => e.id === sp.get("entry")) ? (sp.get("entry") as EntryId) : null);
  const [crewData, setCrewData] = useState<Record<string, unknown>>({});
  const [draft, setDraft] = useState<Partial<CreateTaskBody> | null>(null);
  const preset = useMemo(() => ({ playbook: (draft?.playbookId as string | undefined) ?? sp.get("playbook") ?? undefined, asset: (draft?.params?.["outputAssetKey"] as string | undefined) ?? sp.get("asset") ?? undefined, taskId: sp.get("task") ?? undefined }), [sp, draft]);

  useEffect(() => {
    void loadAssets().then(setAssets);
  }, []);
  // Crew 数据：真实调用结果（未部署的端点不写入 → 角色显示「今晚没动作」）
  useEffect(() => {
    let alive = true;
    (async () => {
      const data: Record<string, unknown> = {};
      const ctx = await marketContext.get(account ? { owner: account } : {}).catch(() => null);
      if (ctx && ctx.status === 200) {
        data["context"] = ctx.data;
        const ev = [...(ctx.data.events ?? [])].sort((a, b) => a.dateLocal.localeCompare(b.dateLocal))[0];
        if (ev) data["nextEvent"] = ev;
      }
      if (account) {
        const imp = await marketEvents.impacts(account, 48).catch(() => null);
        if (imp && imp.status === 200) data["impacts"] = imp.data.impacts;
      }
      if (alive) setCrewData(data);
    })();
    return () => { alive = false; };
  }, [account]);

  return (
    <>
      <header>
        <h1 className="ag-h1">{zh ? "把今晚的事交给你的 Agent" : "Hand tonight to your agent"}</h1>
        <p className="ag-lead">{zh ? "它先读市场上下文和事件日历，按你定的条件等待或行动；每一步先核验、签证书，再由合约按你签过的边界执行。旧的核验、规划、验证器页面都还在菜单里。" : "It reads the market context and the event calendar, waits or acts by the conditions you set; every step is verified and certified before a contract executes it inside the boundaries you signed. The older verify, plan and verifier pages are still in the menu."}</p>
      </header>
      <div className="ag-entries" role="tablist" aria-label={zh ? "四个入口" : "Four entries"}>
        {ENTRIES.map((e) => {
          const Icon = ICONS[e.id];
          return <button key={e.id} type="button" role="tab" className="ag-entry" aria-pressed={entry === e.id} aria-selected={entry === e.id} onClick={() => setEntry(entry === e.id ? null : e.id)}><Icon size={20} aria-hidden="true" /><strong>{t(e.key)}</strong><span>{e.blurb[locale]}</span></button>;
        })}
      </div>
      {entry && <Card title={t(ENTRIES.find((e) => e.id === entry)!.key)}><EntryPanel entry={entry} assets={assets} preset={preset} /></Card>}
      <NlBox onDraft={(d) => { setDraft(d); setEntry("buy"); }} />
      <FirstMinute assets={assets} />
      <Card title={zh ? "今晚的 Crew" : "Tonight's crew"} right={<span className="ag-note">{zh ? "台词只复述真实响应字段" : "lines quote real response fields only"}</span>}><Crew data={crewData} /></Card>
      <Missions />
    </>
  );
}
