"use client";
/** /agent/funds：组合（GET /v1/portfolio/:owner）+ 资金组（GET /v1/budget-groups/:id）+ 现金下限；服务额度与链上额度分开显示。 */
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useI18n } from "@/lib/i18n";
import { budgetGroups, notReady, portfolio, type BudgetGroupView, type PortfolioView } from "@/lib/api-v2";
import { apiError } from "@/lib/errors";
import { rawToHuman } from "@/lib/format";
import { Card, Pill } from "@/components/ui";
import { NotReady, OwnerField, shortKey, useOwnerInput } from "../shared";

type L<T> = { kind: "idle" } | { kind: "busy" } | { kind: "nr"; http: number } | { kind: "err"; msg: string } | { kind: "ok"; v: T };

export function Funds() {
  const { locale, t } = useI18n();
  const zh = locale === "zh";
  const sp = useSearchParams();
  const { owner, setOwner, connected, valid } = useOwnerInput();
  const [pf, setPf] = useState<L<PortfolioView>>({ kind: "idle" });
  const [groupId, setGroupId] = useState(sp.get("group") ?? "");
  const [bg, setBg] = useState<L<BudgetGroupView>>({ kind: "idle" });
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", inputAssetKey: "", capRaw: "", cashFloorRaw: "0" });
  useEffect(() => {
    if (!valid) return;
    let alive = true;
    setPf({ kind: "busy" });
    portfolio.get(owner.toLowerCase()).then((r) => alive && setPf(notReady(r) ? { kind: "nr", http: r.status } : r.status !== 200 ? { kind: "err", msg: apiError(r, locale) } : { kind: "ok", v: r.data })).catch(() => alive && setPf({ kind: "nr", http: 0 }));
    return () => { alive = false; };
  }, [owner, valid, locale]);
  useEffect(() => {
    if (!groupId.trim()) return;
    let alive = true;
    setBg({ kind: "busy" });
    budgetGroups.get(groupId.trim()).then((r) => alive && setBg(notReady(r) ? { kind: "nr", http: r.status } : r.status !== 200 ? { kind: "err", msg: apiError(r, locale) } : { kind: "ok", v: r.data })).catch(() => alive && setBg({ kind: "nr", http: 0 }));
    return () => { alive = false; };
  }, [groupId, locale]);
  async function create() {
    setCreating(true);
    const now = new Date();
    const end = new Date(now.getTime() + 30 * 86_400_000);
    const r = await budgetGroups.create({ owner: owner.toLowerCase() as `0x${string}`, name: form.name, inputAssetKey: form.inputAssetKey, periodStart: now.toISOString(), periodEnd: end.toISOString(), capRaw: form.capRaw, cashFloorRaw: form.cashFloorRaw || "0" }).catch(() => null);
    setCreating(false);
    if (!r) return setBg({ kind: "nr", http: 0 });
    if (notReady(r)) return setBg({ kind: "nr", http: r.status });
    if (r.status !== 201) return setBg({ kind: "err", msg: apiError(r, locale) });
    setGroupId(r.data.id);
  }
  const sum = (v: PortfolioView) => v.holdings.length;
  return (
    <>
      <header><h1 className="ag-h1">{t("nav_agent_funds")}</h1><p className="ag-lead">{zh ? "可用、预留、在途、成本已知范围、现金下限、任务冲突。余额对应区块号；成本只覆盖能追溯的数量，未知不算零。" : "Available, reserved, in-flight, cost coverage, cash floor, task conflicts. Balances are pinned to a block; cost covers traceable quantity only — unknown is not zero."}</p></header>
      <Card title={zh ? "组合" : "Portfolio"}>
        <div className="ag-form"><OwnerField owner={owner} setOwner={setOwner} connected={connected} /></div>
        {pf.kind === "busy" && <p className="ag-note mt-2">{t("ag_loading")}</p>}
        {pf.kind === "nr" && <div className="mt-3"><NotReady what="GET /v1/portfolio/:owner" status={pf.http} /></div>}
        {pf.kind === "err" && <p className="mt-2 text-sm text-bad">{pf.msg}</p>}
        {pf.kind === "ok" && (
          <div className="mt-3 space-y-2">
            <p className="ag-note">{zh ? "区块" : "block"} <span className="mono">{(pf.v.block?.number ?? pf.v.blockNumber)}</span> · chain {pf.v.chainId} · {sum(pf.v)} {zh ? "项持仓" : "holding(s)"}</p>
            <ul className="ag-list">{pf.v.holdings.map((h) => <li key={h.assetKey}><div className="ag-actions"><span className="font-semibold">{h.displaySymbol ?? shortKey(h.assetKey)}</span><span className="mono text-xs">{h.balanceRaw}</span>{h.tracedQtyRaw !== null && h.tracedQtyRaw !== undefined && <Pill tone={h.tracedQtyRaw === h.balanceRaw ? "ok" : "warn"}>{zh ? "可追溯" : "traced"} {h.tracedQtyRaw}</Pill>}{typeof h.costCoverageBps === "number" && <Pill tone={h.costCoverageBps >= 10_000 ? "ok" : "warn"}>{zh ? "成本覆盖" : "cost coverage"} {(h.costCoverageBps / 100).toFixed(0)}%</Pill>}{h.source === "user_reported" && <Pill tone="info">user_reported</Pill>}</div></li>)}</ul>
            {pf.v.unitAdjustments?.length ? <p className="ag-note">{zh ? "发行商数量调整" : "issuer unit adjustments"}: {pf.v.unitAdjustments.map((u) => `${shortKey(u.assetKey)} ${u.note}`).join("; ")}</p> : null}
          </div>
        )}
      </Card>
      <div className="ag-grid-2">
        <Card title={zh ? "资金组" : "Budget group"}>
          <div className="ag-form"><label className="ag-span">{zh ? "资金组 id" : "Budget group id"}<input className="field mono" value={groupId} onChange={(e) => setGroupId(e.target.value)} placeholder="bg_…" /></label></div>
          {bg.kind === "busy" && <p className="ag-note mt-2">{t("ag_loading")}</p>}
          {bg.kind === "nr" && <div className="mt-3"><NotReady what="/v1/budget-groups" status={bg.http} /></div>}
          {bg.kind === "err" && <p className="mt-2 text-sm text-bad">{bg.msg}</p>}
          {bg.kind === "ok" && (
            <dl className="ag-kv mt-3">
              <dt>{zh ? "名称" : "name"}</dt><dd>{bg.v.name}</dd>
              <dt>{zh ? "上限（服务额度）" : "cap (service)"}</dt><dd className="mono">{rawToHuman(bg.v.capRaw, 6)}</dd>
              <dt>{zh ? "现金下限" : "cash floor"}</dt><dd className="mono">{rawToHuman(bg.v.cashFloorRaw, 6)}</dd>
              <dt>{zh ? "已花 / 预留 / 在途" : "spent / reserved / pending"}</dt><dd className="mono">{rawToHuman(bg.v.spentRaw ?? "0", 6)} / {rawToHuman(bg.v.reservedRaw ?? "0", 6)} / {rawToHuman(bg.v.pendingRaw ?? "0", 6)}</dd>
              <dt>{zh ? "周期" : "period"}</dt><dd className="mono text-xs">{bg.v.periodStart} → {bg.v.periodEnd}</dd>
              <dt>{zh ? "分配" : "allocations"}</dt><dd>{bg.v.allocations.length === 0 ? "—" : <ul className="ag-list">{bg.v.allocations.map((a) => <li key={`${a.taskId}-${a.mandateId}`}><Pill tone={a.state === "reserved" ? "ok" : a.state === "waiting" ? "warn" : "neutral"}>{a.state}</Pill> <span className="mono text-xs">{a.taskId}</span> · {zh ? "优先级" : "priority"} {a.priority} · {rawToHuman(a.reservedRaw, 6)}</li>)}</ul>}</dd>
            </dl>
          )}
          <p className="ag-note mt-3">{zh ? "不变量：本期已花 + 可执行授权的预留 ≤ 上限；链上额度（钱包对 PlanGuard 的 allowance）另行显示在任务页，不与服务额度混算。" : "Invariant: spentThisPeriod + Σ reserved ≤ cap. The on-chain allowance (wallet → PlanGuard) is shown separately on the task page and never mixed with the service cap."}</p>
        </Card>
        <Card title={zh ? "新建资金组" : "Create a budget group"}>
          <div className="ag-form">
            <label>{zh ? "名称" : "Name"}<input className="field" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <label>{zh ? "资金币种 assetKey" : "Input assetKey"}<input className="field mono" value={form.inputAssetKey} onChange={(e) => setForm({ ...form, inputAssetKey: e.target.value.trim() })} placeholder="eip155:196:0x…" /></label>
            <label>{zh ? "上限（最小单位）" : "Cap (raw)"}<input className="field mono" inputMode="numeric" value={form.capRaw} onChange={(e) => setForm({ ...form, capRaw: e.target.value.trim() })} /></label>
            <label>{zh ? "现金下限（最小单位）" : "Cash floor (raw)"}<input className="field mono" inputMode="numeric" value={form.cashFloorRaw} onChange={(e) => setForm({ ...form, cashFloorRaw: e.target.value.trim() })} /></label>
          </div>
          <div className="ag-actions mt-3"><button className="btn" disabled={creating || !valid || !form.name || !/^eip155:\d+:0x[0-9a-f]{40}$/.test(form.inputAssetKey) || !/^\d+$/.test(form.capRaw)} onClick={create}>{zh ? "创建（30 天周期）" : "Create (30-day period)"}</button></div>
        </Card>
      </div>
    </>
  );
}
