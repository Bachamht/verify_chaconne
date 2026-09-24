"use client";
/**
 * /agent/funds：组合（GET /v1/portfolio/:owner）+ 资金组（GET /v1/budget-groups/:id）+ 现金下限；服务额度与链上额度分开显示。
 * V-31：unavailable 的余额显示「—」并标明来源故障（链上读取失败），绝不渲染成 0；能连 RPC 时直读一次作为兜底并标注；资产用符号不用地址。
 */
import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useI18n } from "@/lib/i18n";
import { budgetGroups, notReady, portfolio, type BudgetGroupView, type PortfolioView } from "@/lib/api-v2";
import { apiError } from "@/lib/errors";
import { formatAmount, formatTime } from "@/lib/format";
import { assetByKey, loadAssets, type AssetEntry } from "@/lib/assets";
import { balanceOf } from "@/lib/wallet";
import { Card, Pill } from "@/components/ui";
import { LoadingState, NotReady, OwnerField, Skeleton, shortKey, useOwnerInput } from "../shared";

type L<T> = { kind: "idle" } | { kind: "busy" } | { kind: "nr"; http: number } | { kind: "err"; msg: string } | { kind: "ok"; v: T };
type Rpc = { kind: "busy" } | { kind: "ok"; raw: string } | { kind: "fail" };

export function Funds() {
  const { locale, t } = useI18n();
  const zh = locale === "zh";
  const sp = useSearchParams();
  const { owner, setOwner, connected, valid } = useOwnerInput();
  const [assets, setAssets] = useState<AssetEntry[]>([]);
  const [pf, setPf] = useState<L<PortfolioView>>({ kind: "idle" });
  const [rpc, setRpc] = useState<Record<string, Rpc>>({});
  const [groupId, setGroupId] = useState(sp.get("group") ?? "");
  const [bg, setBg] = useState<L<BudgetGroupView>>({ kind: "idle" });
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: "", inputAssetKey: "", capRaw: "", cashFloorRaw: "0" });
  useEffect(() => { void loadAssets().then((r) => setAssets(r.assets)); }, []);
  const [pfSeq, setPfSeq] = useState(0);
  const reloadPf = useCallback(() => setPfSeq((n) => n + 1), []);
  useEffect(() => {
    if (!valid) return;
    let alive = true;
    setPf({ kind: "busy" });
    setRpc({});
    portfolio.get(owner.toLowerCase()).then((r) => alive && setPf(r.status === 0 || notReady(r) ? { kind: "nr", http: r.status } : r.status !== 200 ? { kind: "err", msg: apiError(r, locale) } : { kind: "ok", v: r.data })).catch(() => alive && setPf({ kind: "nr", http: 0 }));
    return () => { alive = false; };
  }, [owner, valid, locale, pfSeq]);
  // RPC 兜底：服务端读不到的余额，浏览器直接 eth_call 一次（只读，不弹窗）；读到就标「RPC 直读」，读不到仍是「未知」
  useEffect(() => {
    if (pf.kind !== "ok" || !valid || assets.length === 0) return;
    const rows = [...(pf.v.cash ?? []), ...pf.v.holdings].filter((x) => x.unavailable);
    if (rows.length === 0) return;
    let alive = true;
    setRpc(Object.fromEntries(rows.map((x) => [x.assetKey, { kind: "busy" } as Rpc])));
    for (const x of rows) {
      const a = assetByKey(assets, x.assetKey);
      if (!a) { setRpc((m) => ({ ...m, [x.assetKey]: { kind: "fail" } })); continue; }
      balanceOf(a.tokenAddress as `0x${string}`, owner as `0x${string}`)
        .then((b) => alive && setRpc((m) => ({ ...m, [x.assetKey]: { kind: "ok", raw: b.toString() } })))
        .catch(() => alive && setRpc((m) => ({ ...m, [x.assetKey]: { kind: "fail" } })));
    }
    return () => { alive = false; };
  }, [pf, valid, assets, owner]);
  useEffect(() => {
    if (!groupId.trim()) return;
    let alive = true;
    setBg({ kind: "busy" });
    budgetGroups.get(groupId.trim()).then((r) => alive && setBg(r.status === 0 || notReady(r) ? { kind: "nr", http: r.status } : r.status !== 200 ? { kind: "err", msg: apiError(r, locale) } : { kind: "ok", v: r.data })).catch(() => alive && setBg({ kind: "nr", http: 0 }));
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
  const symbolOf = (key: string, given?: string) => given ?? assetByKey(assets, key)?.displaySymbol ?? shortKey(key);
  const decimalsOf = (key: string, given?: number) => given ?? assetByKey(assets, key)?.tokenDecimals ?? 6;
  /** 一行余额：可用 → 金额；不可用 → RPC 兜底或「—」+ 来源故障 */
  const Balance = ({ assetKey, raw, decimals, symbol, unavailable }: { assetKey: string; raw: string; decimals: number; symbol: string; unavailable?: boolean }) => {
    if (!unavailable) return <span className="mono text-sm">{formatAmount(raw, decimals, symbol)}</span>;
    const r = rpc[assetKey];
    if (r?.kind === "ok") return <span className="ag-actions"><span className="mono text-sm">{formatAmount(r.raw, decimals, symbol)}</span><Pill tone="info">{zh ? "RPC 直读（服务端读取失败）" : "read via RPC (service read failed)"}</Pill></span>;
    return <span className="ag-actions"><span className="mono text-sm">—</span><Pill tone="warn">{r?.kind === "busy" ? (zh ? "服务端读取失败 · 正在直读 RPC" : "service read failed · reading via RPC") : (zh ? "未知：链上余额读取失败，不当作 0" : "unknown: on-chain read failed; not treated as 0")}</Pill></span>;
  };
  const unavailableCount = pf.kind === "ok" ? [...(pf.v.cash ?? []), ...pf.v.holdings].filter((x) => x.unavailable).length : 0;
  return (
    <>
      <header><h1 className="ag-h1">{t("ag_funds_h")}</h1><p className="ag-lead">{zh ? "可用、预留、在途、成本已知范围、现金下限、任务冲突。余额对应区块号；成本只覆盖能追溯的数量，未知不算零。" : "Available, reserved, in-flight, cost coverage, cash floor, task conflicts. Balances are pinned to a block; cost covers traceable quantity only — unknown is not zero."}</p></header>
      <Card title={zh ? "组合" : "Portfolio"}>
        <div className="ag-form"><OwnerField owner={owner} setOwner={setOwner} connected={connected} /></div>
        {pf.kind === "busy" && <div className="mt-3 space-y-2" aria-busy="true"><LoadingState onRetry={reloadPf} /><Skeleton lines={4} /></div>}
        {pf.kind === "nr" && <div className="mt-3"><NotReady what="GET /v1/portfolio/:owner" status={pf.http} onRetry={reloadPf} /></div>}
        {pf.kind === "err" && <p className="mt-2 text-sm text-bad">{pf.msg}</p>}
        {pf.kind === "ok" && (
          <div className="mt-3 space-y-3">
            <p className="ag-note">{zh ? "区块" : "block"} <span className="mono">{pf.v.block?.number ?? pf.v.blockNumber ?? "—"}</span>{pf.v.block?.timestamp ? ` · ${zh ? "截至" : "as of"} ${formatTime(pf.v.block.timestamp, locale)}` : ""} · X Layer {pf.v.chainId} · {pf.v.holdings.length} {zh ? "项持仓" : "holding(s)"}</p>
            {unavailableCount > 0 && <p className="ag-warn">{zh ? `服务端有 ${unavailableCount} 项余额读取失败（链上 RPC 故障）。这些项显示「—」而不是 0；页面会用浏览器直接读一次链作为兜底。` : `${unavailableCount} balance(s) could not be read by the service (on-chain RPC failure). They show "—", not 0; the page reads the chain directly once as a fallback.`}</p>}
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-fg-3">{zh ? "资金币种" : "Funding currencies"}</p>
              {(pf.v.cash ?? []).length === 0 ? <p className="ag-note">—</p> : <ul className="ag-list">{(pf.v.cash ?? []).map((c) => <li key={c.assetKey}><div className="ag-actions"><span className="font-semibold">{symbolOf(c.assetKey, c.symbol)}</span><Balance assetKey={c.assetKey} raw={c.balanceRaw} decimals={decimalsOf(c.assetKey, c.decimals)} symbol={symbolOf(c.assetKey, c.symbol)} unavailable={c.unavailable} /></div></li>)}</ul>}
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-fg-3">{zh ? "持仓" : "Holdings"}</p>
              {pf.v.holdings.length === 0 ? <p className="ag-note">{zh ? "没有可追溯或有余额的股票持仓。" : "No stock holding with a balance or traced fills."}</p> : (
                <ul className="ag-list">{pf.v.holdings.map((h) => {
                  const sym = symbolOf(h.assetKey, h.symbol ?? h.displaySymbol);
                  const dec = decimalsOf(h.assetKey, h.decimals);
                  const cov = h.coverage?.coverageBps ?? h.costCoverageBps ?? null;
                  const traced = h.traced?.qtyRaw ?? h.tracedQtyRaw ?? null;
                  return (
                    <li key={h.assetKey}>
                      <div className="ag-actions">
                        <span className="font-semibold">{sym}</span>
                        <Balance assetKey={h.assetKey} raw={h.balanceRaw} decimals={dec} symbol={sym} unavailable={h.unavailable} />
                        {traced !== null && !h.unavailable && <Pill tone={traced === h.balanceRaw ? "ok" : "warn"}>{zh ? "可追溯" : "traced"} {formatAmount(traced, dec)}</Pill>}
                        {typeof cov === "number" && <Pill tone={cov >= 10_000 ? "ok" : "warn"}>{zh ? "成本覆盖" : "cost coverage"} {(cov / 100).toFixed(0)}%</Pill>}
                        {cov === null && !h.unavailable && <Pill tone="neutral">{zh ? "成本覆盖未知" : "cost coverage unknown"}</Pill>}
                        {(h.source === "user_reported" || h.userReported) && <Pill tone="info">{zh ? "含自报成本" : "includes self-reported cost"}</Pill>}
                      </div>
                    </li>
                  );
                })}</ul>
              )}
            </div>
            {pf.v.unitAdjustments?.length ? <p className="ag-note">{zh ? "发行商数量调整" : "issuer unit adjustments"}: {pf.v.unitAdjustments.map((u) => `${symbolOf(u.assetKey)} ${u.note}`).join("; ")}</p> : null}
            <details><summary className="ag-note cursor-pointer">{t("ag_dev_view")}</summary><pre className="ag-json">{JSON.stringify(pf.v, null, 2)}</pre></details>
          </div>
        )}
      </Card>
      <div className="ag-grid-2">
        <Card title={zh ? "资金组" : "Budget group"}>
          <div className="ag-form"><label className="ag-span">{zh ? "资金组 id" : "Budget group id"}<input className="field mono" value={groupId} onChange={(e) => setGroupId(e.target.value)} placeholder="bg_…" /></label></div>
          {bg.kind === "busy" && <div className="mt-3"><LoadingState /><Skeleton lines={3} /></div>}
          {bg.kind === "nr" && <div className="mt-3"><NotReady what="/v1/budget-groups" status={bg.http} /></div>}
          {bg.kind === "err" && <p className="mt-2 text-sm text-bad">{bg.msg}</p>}
          {bg.kind === "ok" && (() => { const dec = decimalsOf(bg.v.inputAssetKey); const sym = symbolOf(bg.v.inputAssetKey); return (
            <dl className="ag-kv mt-3">
              <dt>{zh ? "名称" : "name"}</dt><dd>{bg.v.name}</dd>
              <dt>{zh ? "资金币种" : "currency"}</dt><dd>{sym}</dd>
              <dt>{zh ? "上限（服务额度）" : "cap (service)"}</dt><dd className="mono">{formatAmount(bg.v.capRaw, dec, sym)}</dd>
              <dt>{zh ? "现金下限" : "cash floor"}</dt><dd className="mono">{formatAmount(bg.v.cashFloorRaw, dec, sym)}</dd>
              <dt>{zh ? "已花 / 预留 / 在途" : "spent / reserved / pending"}</dt><dd className="mono">{formatAmount(bg.v.spentRaw ?? "0", dec)} / {formatAmount(bg.v.reservedRaw ?? "0", dec)} / {formatAmount(bg.v.pendingRaw ?? "0", dec)} {sym}</dd>
              <dt>{zh ? "周期" : "period"}</dt><dd className="text-xs">{formatTime(bg.v.periodStart, locale)} → {formatTime(bg.v.periodEnd, locale)}</dd>
              <dt>{zh ? "分配" : "allocations"}</dt><dd>{bg.v.allocations.length === 0 ? "—" : <ul className="ag-list">{bg.v.allocations.map((a) => <li key={`${a.taskId}-${a.mandateId}`}><Pill tone={a.state === "reserved" ? "ok" : a.state === "waiting" ? "warn" : "neutral"}>{a.state}</Pill> <span className="mono text-xs">{a.taskId}</span> · {zh ? "优先级" : "priority"} {a.priority} · {formatAmount(a.reservedRaw, dec, sym)}</li>)}</ul>}</dd>
            </dl>
          ); })()}
          <p className="ag-note mt-3">{zh ? "不变量：本期已花 + 可执行授权的预留 ≤ 上限；链上额度（钱包对 PlanGuard 的 allowance）另行显示在任务页，不与服务额度混算。" : "Invariant: spentThisPeriod + Σ reserved ≤ cap. The on-chain allowance (wallet → PlanGuard) is shown separately on the task page and never mixed with the service cap."}</p>
        </Card>
        <Card title={zh ? "新建资金组" : "Create a budget group"}>
          <div className="ag-form">
            <label>{zh ? "名称" : "Name"}<input className="field" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <label>{zh ? "资金币种" : "Currency"}<select className="field" value={form.inputAssetKey} onChange={(e) => setForm({ ...form, inputAssetKey: e.target.value })}><option value="">—</option>{assets.filter((a) => a.role === "stable_input").map((a) => <option key={a.assetKey} value={a.assetKey}>{a.displaySymbol}</option>)}</select></label>
            <label>{zh ? "上限（最小单位）" : "Cap (raw)"}<input className="field mono" inputMode="numeric" value={form.capRaw} onChange={(e) => setForm({ ...form, capRaw: e.target.value.trim() })} /></label>
            <label>{zh ? "现金下限（最小单位）" : "Cash floor (raw)"}<input className="field mono" inputMode="numeric" value={form.cashFloorRaw} onChange={(e) => setForm({ ...form, cashFloorRaw: e.target.value.trim() })} /></label>
          </div>
          <div className="ag-actions mt-3"><button className="btn" disabled={creating || !valid || !form.name || !/^eip155:\d+:0x[0-9a-fA-F]{40}$/.test(form.inputAssetKey) || !/^\d+$/.test(form.capRaw)} onClick={create}>{zh ? "创建（30 天周期）" : "Create (30-day period)"}</button></div>
        </Card>
      </div>
    </>
  );
}
