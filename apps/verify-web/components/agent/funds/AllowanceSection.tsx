"use client";
/**
 * P4：资金页「给 PlanGuard 的额度」（只在 NEXT_PUBLIC_V7_UI=1 时挂载）。
 * 数据 = GET /v1/owners/:owner/allowances（链上额度、账本需要量、差额、在途 permit）。
 * 两种清理入口：签一份 reclaim permit（平台代付上链；POST …/reclaim → 签名 → POST …/submit），或自己发 approve(PlanGuard, 0)（交易，自己付 gas）。
 */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { notReady, v7, type OwnerAllowanceRow } from "@/lib/api-v2";
import { apiError } from "@/lib/errors";
import { formatAmount } from "@/lib/format";
import { assetByKey, type AssetEntry } from "@/lib/assets";
import { PLANGUARD_ADDRESS } from "@/lib/planGuardAbi";
import { Card, Pill } from "@/components/ui";
import { ModeTag, NotReady, Toast, useToast } from "../shared";
import { useV7 } from "../tasks/v7/useV7";
import { fxOwnerAllowances } from "@/lib/v7fixtures";
import { approveZero, reclaimExcess, type AllowanceActionOutcome } from "./allowanceActions";
import "../v7.css";

/** 多出的量：服务端给 excessRaw 就用，否则 onchain − required（不为负） */
export function excessOf(r: Pick<OwnerAllowanceRow, "onchainRaw" | "requiredRaw" | "excessRaw">): bigint {
  if (r.excessRaw && /^\d+$/.test(r.excessRaw)) return BigInt(r.excessRaw);
  const on = /^\d+$/.test(r.onchainRaw) ? BigInt(r.onchainRaw) : 0n;
  const req = /^\d+$/.test(r.requiredRaw) ? BigInt(r.requiredRaw) : 0n;
  return on > req ? on - req : 0n;
}

export function AllowanceSection({ owner, assets, fixture = false }: { owner: string; assets: AssetEntry[]; fixture?: boolean }) {
  const { s, locale } = useV7();
  const [rows, setRows] = useState<OwnerAllowanceRow[] | null>(fixture ? fxOwnerAllowances().allowances : null);
  const [nr, setNr] = useState<number | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useToast();
  const load = useCallback(async () => {
    if (fixture || !owner) return;
    const r = await v7.ownerAllowances(owner).catch(() => null);
    if (!r || r.status === 0) { setNr(0); return; }
    if (notReady(r)) { setNr(r.status); return; }
    if (r.status !== 200) { setToast({ text: apiError(r, locale), tone: "bad" }); return; }
    setRows(r.data.allowances);
    setNr(null);
  }, [fixture, owner, locale, setToast]);
  useEffect(() => { void load(); }, [load]);

  function show(o: AllowanceActionOutcome, okText: string, rejectedText: string) {
    if (o.kind === "ok") { setToast({ text: okText, tone: "ok" }); void load(); return; }
    if (o.kind === "api") { setToast({ text: apiError(o.res, locale), tone: "bad" }); return; }
    if (o.kind === "unreachable") { setToast({ text: s("unreachable"), tone: "bad" }); return; }
    if (o.kind === "rejected") { setToast({ text: rejectedText, tone: "warn" }); return; }
    setToast({ text: o.message, tone: "bad" });
  }
  async function reclaim(row: OwnerAllowanceRow) {
    if (fixture) return;
    setBusy(`r:${row.token}`);
    try {
      show(await reclaimExcess(owner, row, locale === "zh"), s("al_reclaim_sent"), locale === "zh" ? "已取消签名" : "Signature cancelled");
    } finally {
      setBusy(null);
    }
  }
  async function approveZeroRow(row: OwnerAllowanceRow) {
    if (fixture || !PLANGUARD_ADDRESS) return;
    if (!window.confirm(s("al_approve0_note"))) return;
    setBusy(`z:${row.token}`);
    try {
      show(await approveZero(owner, row, locale === "zh"), locale === "zh" ? "额度已清零" : "Allowance set to zero", locale === "zh" ? "已取消" : "Cancelled");
    } finally {
      setBusy(null);
    }
  }

  const sym = (k: string) => assetByKey(assets, k)?.displaySymbol ?? k.slice(-6);
  const dec = (k: string) => assetByKey(assets, k)?.tokenDecimals ?? 18;
  return (
    <div id="allowances">
      <Card title={s("al_h")} right={fixture ? <ModeTag mode="FIXTURE" /> : undefined}>
        <p className="ag-note">{s("al_lead")}</p>
        {!owner ? null : nr !== null ? <div className="mt-3"><NotReady what="GET /v1/owners/:owner/allowances" status={nr} onRetry={() => void load()} /></div> : !rows ? <p className="ag-note mt-2">{s("loading")}</p> : rows.length === 0 ? <p className="ag-note mt-2">{s("al_empty")}</p> : (
          <div className="v7-rows mt-3">
            <div className="v7-row v7-row-head"><span>{s("al_token")}</span><span>{s("al_onchain")}</span><span>{s("al_required")}</span><span>{s("al_excess")}</span></div>
            {rows.map((r) => {
              const ex = excessOf(r);
              return (
                <div key={r.token} className="v7-row">
                  <span><strong>{sym(r.assetKey)}</strong>{r.pendingPermit && <> <Pill tone="info">{s("al_pending")}</Pill></>}
                    {ex > 0n && (
                      <span className="ag-actions mt-1">
                        <button type="button" className="btn-ghost h-8 px-3 text-xs" disabled={busy !== null || fixture || r.pendingPermit} onClick={() => void reclaim(r)}>{busy === `r:${r.token}` ? s("loading") : s("al_reclaim")}</button>
                        <button type="button" className="btn-ghost h-8 px-3 text-xs" disabled={busy !== null || fixture || !PLANGUARD_ADDRESS} onClick={() => void approveZeroRow(r)}>{busy === `z:${r.token}` ? s("loading") : s("al_approve0")}</button>
                      </span>
                    )}
                  </span>
                  <span><span className="v7-k">{s("al_onchain")}</span><span className="mono">{formatAmount(r.onchainRaw, dec(r.assetKey), undefined, 6)}</span></span>
                  <span><span className="v7-k">{s("al_required")}</span><span className="mono">{formatAmount(r.requiredRaw, dec(r.assetKey), undefined, 6)}</span></span>
                  <span><span className="v7-k">{s("al_excess")}</span><span className="mono">{formatAmount(ex.toString(), dec(r.assetKey), undefined, 6)}</span></span>
                </div>
              );
            })}
          </div>
        )}
        <p className="ag-note mt-3">{s("al_reclaim_note")}</p>
        <p className="ag-note">{s("al_risk_note")}</p>
        <p className="ag-note"><Link className="underline" href="/agent/tasks">{locale === "zh" ? "授权在各任务页里暂停、取消或链上撤销" : "Pause, cancel or revoke authorizations on each task page"}</Link></p>
      </Card>
      <Toast msg={toast} onClose={() => setToast(null)} />
    </div>
  );
}
